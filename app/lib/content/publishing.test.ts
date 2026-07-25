import { describe, expect, it, vi } from "vitest";
import {
  PublishAuthenticationError,
  PublishCanceledAfterContainerError,
  PublishOutcomeUnknownError,
  publishPost,
} from "./publishing";
import type { PublishedItem, SocialPlatformAdapter } from "./social-content";
import type { Post } from "../shared/types";

const draft: Post = {
  id: "draft-1",
  imageUrl: "https://cdn.example.com/launch.jpg",
  caption: "The launch starts here.",
  status: "draft",
};

// A stand-in adapter keeps these tests about the platform-neutral publisher:
// validation, media preparation, cleanup, and failure mapping. Instagram's own
// dispatch is covered in platforms/instagram-adapter.test.ts, and the connection
// half of the adapter is exercised through connection-lifecycle.test.ts.
function fakeAdapter(
  overrides: Partial<SocialPlatformAdapter> = {},
): SocialPlatformAdapter {
  return {
    platform: "instagram",
    capabilities: { mediaTypes: ["image", "video"], maxCaptionLength: 2200 },
    credentialLifetime: { assumedLifetimeMs: 1, refreshFloorMs: 1, refreshWindowMs: 1 },
    credentialRequest: { label: "Token", placeholder: "t…", hint: "Paste a token." },
    establishConnection: vi.fn(),
    refreshCredential: vi.fn(),
    classifyCredentialFailure: () => undefined,
    fetchIdentity: vi.fn(),
    directLocalUpload: ["video"],
    publish: vi.fn().mockResolvedValue({ externalId: "ig-42" }),
    classifyPublishFailure: () => "uncertain",
    publishedRead: { publishedHistory: true, metrics: ["likes", "comments"] },
    fetchPublishedContent: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const localImage: Post = {
  ...draft,
  imageUrl: "",
  media: {
    type: "image",
    source: {
      kind: "local",
      assetId: "asset-1.jpg",
      fileName: "photo.png",
      mimeType: "image/jpeg",
      size: 2048,
    },
  },
};

describe("publishPost", () => {
  it("publishes an eligible post and returns its media ID with refreshed posts", async () => {
    const refreshed: PublishedItem[] = [
      { externalId: "ig-42", caption: draft.caption, previewUrl: draft.imageUrl },
    ];
    const adapter = fakeAdapter({
      fetchPublishedContent: vi.fn().mockResolvedValue(refreshed),
    });
    const verifyMediaUrl = vi.fn().mockResolvedValue(undefined);
    const beforePublish = vi.fn().mockResolvedValue(undefined);
    const removeLocalPost = vi.fn().mockResolvedValue(undefined);

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: draft,
          beforePublish,
        },
        { verifyMediaUrl, resolveAdapter: () => adapter, removeLocalPost },
      ),
    ).resolves.toEqual({
      mediaId: "ig-42",
      publishedContent: refreshed,
      localPostRemoved: true,
    });

    expect(verifyMediaUrl).toHaveBeenCalledWith(draft.imageUrl);
    expect(adapter.publish).toHaveBeenCalledWith({
      media: { type: "image", kind: "public-url", url: draft.imageUrl },
      caption: draft.caption,
      credentials: { accessToken: "token", externalIdentityId: "account-7" },
      lifecycle: {
        onProcessing: expect.any(Function),
        onPublishing: expect.any(Function),
      },
    });
    expect(adapter.fetchPublishedContent).toHaveBeenCalledWith({
      accessToken: "token",
      externalIdentityId: "account-7",
    });

    const publish = vi.mocked(adapter.publish);
    const fetchPublishedContent = vi.mocked(adapter.fetchPublishedContent!);
    expect(verifyMediaUrl.mock.invocationCallOrder[0]).toBeLessThan(
      beforePublish.mock.invocationCallOrder[0],
    );
    expect(beforePublish.mock.invocationCallOrder[0]).toBeLessThan(
      publish.mock.invocationCallOrder[0],
    );
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      removeLocalPost.mock.invocationCallOrder[0],
    );
    expect(removeLocalPost).toHaveBeenCalledWith(draft.id);
    expect(removeLocalPost.mock.invocationCallOrder[0]).toBeLessThan(
      fetchPublishedContent.mock.invocationCallOrder[0],
    );
  });

  it("routes the publication to the adapter registered for the delivery's platform", async () => {
    const instagram = fakeAdapter();
    const resolveAdapter = vi.fn().mockReturnValue(instagram);

    await publishPost(
      {
        platform: "instagram",
        accessToken: "token",
        externalIdentityId: "account-7",
        post: draft,
      },
      {
        verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
        resolveAdapter,
        removeLocalPost: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(resolveAdapter).toHaveBeenCalledWith("instagram");
  });

  it("stages local media the platform must fetch, then cleans up cloud and local copies", async () => {
    const adapter = fakeAdapter();
    const stageLocalImage = vi.fn().mockResolvedValue({
      objectKey: "socialite/account-7/object.jpg",
      publicUrl: "https://r2.example.com/signed-image",
    });
    const deleteStagedMedia = vi.fn().mockResolvedValue(undefined);
    const deleteManagedMedia = vi.fn().mockResolvedValue(undefined);

    await publishPost(
      {
        platform: "instagram",
        accessToken: "token",
        externalIdentityId: "account-7",
        post: localImage,
      },
      {
        resolveAdapter: () => adapter,
        stageLocalImage,
        deleteStagedMedia,
        deleteManagedMedia,
        removeLocalPost: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(stageLocalImage).toHaveBeenCalledWith("asset-1.jpg", "account-7");
    expect(adapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        media: {
          type: "image",
          kind: "public-url",
          url: "https://r2.example.com/signed-image",
        },
      }),
    );
    expect(deleteStagedMedia).toHaveBeenCalledWith("socialite/account-7/object.jpg");
    expect(deleteManagedMedia).toHaveBeenCalledWith("asset-1.jpg");
  });

  it("hands a local asset straight to an adapter that uploads that media type itself", async () => {
    const reel: Post = {
      ...draft,
      imageUrl: "",
      media: {
        type: "reel",
        source: {
          kind: "local",
          assetId: "asset-2.mp4",
          fileName: "launch.mp4",
          mimeType: "video/mp4",
          size: 4096,
        },
        shareToFeed: false,
      },
    };
    const adapter = fakeAdapter();
    const stageLocalImage = vi.fn();

    await publishPost(
      {
        platform: "instagram",
        accessToken: "token",
        externalIdentityId: "account-7",
        post: reel,
      },
      {
        resolveAdapter: () => adapter,
        stageLocalImage,
        deleteManagedMedia: vi.fn().mockResolvedValue(undefined),
        removeLocalPost: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(stageLocalImage).not.toHaveBeenCalled();
    expect(adapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { type: "video", kind: "local-asset", assetId: "asset-2.mp4" },
        platformOptions: { shareToFeed: false },
      }),
    );
  });

  it("refuses a local video no adapter can upload, because staging holds images only", async () => {
    const adapter = fakeAdapter({ directLocalUpload: [] });
    const reel: Post = {
      ...draft,
      imageUrl: "",
      media: {
        type: "reel",
        source: {
          kind: "local",
          assetId: "asset-3.mp4",
          fileName: "launch.mp4",
          mimeType: "video/mp4",
          size: 4096,
        },
        shareToFeed: true,
      },
    };
    const stageLocalImage = vi.fn();

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: reel,
        },
        { resolveAdapter: () => adapter, stageLocalImage, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("Instagram cannot publish a local video yet");

    expect(stageLocalImage).not.toHaveBeenCalled();
    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("keeps managed media when the durable local post cannot be removed", async () => {
    const deleteManagedMedia = vi.fn();

    const result = await publishPost(
      {
        platform: "instagram",
        accessToken: "token",
        externalIdentityId: "account-7",
        post: localImage,
      },
      {
        resolveAdapter: () => fakeAdapter(),
        stageLocalImage: vi.fn().mockResolvedValue({
          objectKey: "socialite/account-7/object.jpg",
          publicUrl: "https://r2.example.com/signed-image",
        }),
        deleteStagedMedia: vi.fn().mockResolvedValue(undefined),
        deleteManagedMedia,
        removeLocalPost: vi.fn().mockRejectedValue(new Error("database locked")),
      },
    );

    expect(result.localPostRemoved).toBe(false);
    expect(deleteManagedMedia).not.toHaveBeenCalled();
  });

  it("distinguishes a canceled upload from an automatically retryable failure", async () => {
    const adapter = fakeAdapter({
      publish: vi.fn().mockRejectedValue(new Error("Reel upload canceled.")),
      classifyPublishFailure: () => "canceled",
    });

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: draft,
        },
        { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter },
      ),
    ).rejects.toBeInstanceOf(PublishCanceledAfterContainerError);
  });

  it.each([
    ["a local file", "file:///Users/me/photo.jpg"],
    ["a blob URL", "blob:http://localhost/photo"],
    ["localhost", "http://localhost:3000/photo.jpg"],
    ["a private IPv4 address", "http://192.168.1.20/photo.jpg"],
    ["an IPv6 loopback address", "http://[::1]/photo.jpg"],
  ])("blocks %s before the platform is mutated", async (_label, imageUrl) => {
    const adapter = fakeAdapter();
    const verifyMediaUrl = vi.fn();

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: { ...draft, imageUrl },
        },
        { verifyMediaUrl, resolveAdapter: () => adapter, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("publicly reachable http(s) URL");

    expect(adapter.publish).not.toHaveBeenCalled();
    expect(adapter.fetchPublishedContent).not.toHaveBeenCalled();
    expect(verifyMediaUrl).not.toHaveBeenCalled();
  });

  it("rejects a post the platform already owns before publishing", async () => {
    const adapter = fakeAdapter();
    const verifyMediaUrl = vi.fn();

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: { ...draft, status: "published" },
        },
        { verifyMediaUrl, resolveAdapter: () => adapter, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("already published");

    expect(adapter.publish).not.toHaveBeenCalled();
    expect(verifyMediaUrl).not.toHaveBeenCalled();
  });

  it("enforces the adapter's declared caption limit", async () => {
    const adapter = fakeAdapter();

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: { ...draft, caption: "a".repeat(2201) },
        },
        { resolveAdapter: () => adapter, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("The target post caption must be 2200 characters or fewer.");

    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses a media type the adapter does not declare support for", async () => {
    const adapter = fakeAdapter({
      capabilities: { mediaTypes: ["image"], maxCaptionLength: 2200 },
    });
    const reel: Post = {
      ...draft,
      media: { type: "reel", source: { kind: "url", url: draft.imageUrl }, shareToFeed: true },
    };

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: reel,
        },
        { resolveAdapter: () => adapter, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("Instagram does not support video deliveries.");

    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("blocks an unreachable public URL before the platform is mutated", async () => {
    const adapter = fakeAdapter();
    const verifyMediaUrl = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Publishing requires a publicly reachable image URL; the media endpoint did not respond successfully.",
        ),
      );

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: draft,
        },
        { verifyMediaUrl, resolveAdapter: () => adapter, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("publicly reachable image URL");

    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("marks an outward publishing error as ambiguous so callers do not retry blindly", async () => {
    const adapter = fakeAdapter({
      publish: vi.fn().mockRejectedValue(new Error("response lost")),
      classifyPublishFailure: () => "uncertain",
    });
    const removeLocalPost = vi.fn();

    const error = await publishPost(
      {
        platform: "instagram",
        accessToken: "token",
        externalIdentityId: "account-7",
        post: draft,
      },
      {
        verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
        resolveAdapter: () => adapter,
        removeLocalPost,
      },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublishOutcomeUnknownError);
    expect((error as PublishOutcomeUnknownError).message).toContain(
      "Instagram did not return a definitive publishing result",
    );
    expect(removeLocalPost).not.toHaveBeenCalled();
  });

  it("preserves an authentication rejection so the affected connection can require reconnection", async () => {
    const platformError = new Error("Token expired");
    const adapter = fakeAdapter({
      publish: vi.fn().mockRejectedValue(platformError),
      classifyPublishFailure: () => "authentication",
    });

    const error = await publishPost(
      {
        platform: "instagram",
        accessToken: "token",
        externalIdentityId: "account-7",
        post: draft,
      },
      {
        verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
        resolveAdapter: () => adapter,
        removeLocalPost: vi.fn(),
      },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublishAuthenticationError);
    expect((error as PublishAuthenticationError).cause).toBe(platformError);
    expect((error as PublishAuthenticationError).message).toBe("Token expired");
  });

  it("preserves the media ID when refreshing visible posts fails", async () => {
    const adapter = fakeAdapter({
      fetchPublishedContent: vi.fn().mockRejectedValue(new Error("refresh unavailable")),
    });

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: draft,
        },
        {
          verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
          resolveAdapter: () => adapter,
          removeLocalPost: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).resolves.toEqual({
      mediaId: "ig-42",
      publishedContent: null,
      localPostRemoved: true,
      refreshError: "refresh unavailable",
    });
  });

  it("reports no published feed for a platform that does not offer that read", async () => {
    const adapter = fakeAdapter({
      publishedRead: { publishedHistory: false, metrics: [] },
      fetchPublishedContent: vi.fn(),
    });

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: draft,
        },
        {
          verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
          resolveAdapter: () => adapter,
          removeLocalPost: vi.fn().mockResolvedValue(undefined),
        },
      ),
      // The publication itself still succeeded, and an unread feed is not an
      // error to report against it.
    ).resolves.toEqual({ mediaId: "ig-42", publishedContent: null, localPostRemoved: true });

    expect(adapter.fetchPublishedContent).not.toHaveBeenCalled();
  });

  it("preserves the media ID and refreshes when local cleanup fails after publishing", async () => {
    const refreshed: PublishedItem[] = [{ externalId: "ig-42", caption: draft.caption }];
    const adapter = fakeAdapter({
      fetchPublishedContent: vi.fn().mockResolvedValue(refreshed),
    });

    await expect(
      publishPost(
        {
          platform: "instagram",
          accessToken: "token",
          externalIdentityId: "account-7",
          post: draft,
        },
        {
          verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
          resolveAdapter: () => adapter,
          removeLocalPost: vi.fn().mockRejectedValue(new Error("database locked")),
        },
      ),
    ).resolves.toEqual({
      mediaId: "ig-42",
      publishedContent: refreshed,
      localPostRemoved: false,
      cleanupError: "database locked",
    });
  });
});
