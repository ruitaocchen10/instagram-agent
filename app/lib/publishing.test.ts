import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./instagram";
import {
  PublishCanceledAfterContainerError,
  PublishOutcomeUnknownError,
  publishPost,
} from "./publishing";
import type { Post } from "./types";

const draft: Post = {
  id: "draft-1",
  imageUrl: "https://cdn.example.com/launch.jpg",
  caption: "The launch starts here.",
  status: "draft",
};

describe("publishPost", () => {
  it("publishes an eligible post and returns its Instagram ID with refreshed media", async () => {
    const refreshed: Post[] = [
      {
        id: "ig-42",
        imageUrl: draft.imageUrl,
        caption: draft.caption,
        status: "published",
      },
    ];
    const verifyMediaUrl = vi.fn().mockResolvedValue(undefined);
    const publishImage = vi.fn().mockResolvedValue("ig-42");
    const beforePublish = vi.fn().mockResolvedValue(undefined);
    const fetchMedia = vi.fn().mockResolvedValue(refreshed);
    const removeLocalPost = vi.fn().mockResolvedValue(undefined);

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: draft,
          config: DEFAULT_CONFIG,
          beforePublish,
        },
        { verifyMediaUrl, publishImage, fetchMedia, removeLocalPost },
      ),
    ).resolves.toEqual({
      mediaId: "ig-42",
      publishedPosts: refreshed,
      localPostRemoved: true,
    });

    expect(verifyMediaUrl).toHaveBeenCalledWith(draft.imageUrl);
    expect(publishImage).toHaveBeenCalledWith(
      "token",
      "account-7",
      draft.imageUrl,
      draft.caption,
      DEFAULT_CONFIG,
      expect.objectContaining({
        onProcessing: expect.any(Function),
        onPublishing: expect.any(Function),
      }),
    );
    expect(fetchMedia).toHaveBeenCalledWith("token", "account-7", DEFAULT_CONFIG);
    expect(verifyMediaUrl.mock.invocationCallOrder[0]).toBeLessThan(
      beforePublish.mock.invocationCallOrder[0],
    );
    expect(beforePublish.mock.invocationCallOrder[0]).toBeLessThan(
      publishImage.mock.invocationCallOrder[0],
    );
    expect(publishImage.mock.invocationCallOrder[0]).toBeLessThan(
      removeLocalPost.mock.invocationCallOrder[0],
    );
    expect(removeLocalPost).toHaveBeenCalledWith(draft.id);
    expect(removeLocalPost.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMedia.mock.invocationCallOrder[0],
    );
  });

  it("stages a local image just in time and cleans up cloud and local media after success", async () => {
    const local: Post = {
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
    const stageLocalImage = vi.fn().mockResolvedValue({
      objectKey: "socialite/account-7/object.jpg",
      publicUrl: "https://r2.example.com/signed-image",
    });
    const publishImage = vi.fn().mockResolvedValue("ig-42");
    const deleteStagedMedia = vi.fn().mockResolvedValue(undefined);
    const deleteManagedMedia = vi.fn().mockResolvedValue(undefined);

    await publishPost(
      {
        accessToken: "token",
        igUserId: "account-7",
        post: local,
        config: DEFAULT_CONFIG,
      },
      {
        stageLocalImage,
        publishImage,
        deleteStagedMedia,
        deleteManagedMedia,
        fetchMedia: vi.fn().mockResolvedValue([]),
        removeLocalPost: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(stageLocalImage).toHaveBeenCalledWith("asset-1.jpg", "account-7");
    expect(publishImage).toHaveBeenCalledWith(
      "token",
      "account-7",
      "https://r2.example.com/signed-image",
      draft.caption,
      DEFAULT_CONFIG,
      expect.objectContaining({
        onProcessing: expect.any(Function),
        onPublishing: expect.any(Function),
      }),
    );
    expect(deleteStagedMedia).toHaveBeenCalledWith("socialite/account-7/object.jpg");
    expect(deleteManagedMedia).toHaveBeenCalledWith("asset-1.jpg");
  });

  it("uploads a local Reel directly to Meta without staging it in R2", async () => {
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
    const stageLocalImage = vi.fn();
    const publishLocalReel = vi.fn().mockResolvedValue("ig-reel-9");

    await publishPost(
      {
        accessToken: "token",
        igUserId: "account-7",
        post: reel,
        config: DEFAULT_CONFIG,
      },
      {
        stageLocalImage,
        publishLocalReel,
        deleteManagedMedia: vi.fn().mockResolvedValue(undefined),
        fetchMedia: vi.fn().mockResolvedValue([]),
        removeLocalPost: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(stageLocalImage).not.toHaveBeenCalled();
    expect(publishLocalReel).toHaveBeenCalledWith(
      "token",
      "account-7",
      "asset-2.mp4",
      draft.caption,
      false,
      DEFAULT_CONFIG,
      expect.objectContaining({
        onProcessing: expect.any(Function),
        onPublishing: expect.any(Function),
      }),
    );
  });

  it("keeps managed media when the durable local post cannot be removed", async () => {
    const local: Post = {
      ...draft,
      imageUrl: "",
      media: {
        type: "image",
        source: {
          kind: "local",
          assetId: "asset-keep.jpg",
          fileName: "keep.jpg",
          mimeType: "image/jpeg",
          size: 2048,
        },
      },
    };
    const deleteManagedMedia = vi.fn();

    const result = await publishPost(
      { accessToken: "token", igUserId: "account-7", post: local, config: DEFAULT_CONFIG },
      {
        stageLocalImage: vi.fn().mockResolvedValue({
          objectKey: "socialite/account-7/object.jpg",
          publicUrl: "https://r2.example.com/signed-image",
        }),
        publishImage: vi.fn().mockResolvedValue("ig-42"),
        deleteStagedMedia: vi.fn().mockResolvedValue(undefined),
        deleteManagedMedia,
        fetchMedia: vi.fn().mockResolvedValue([]),
        removeLocalPost: vi.fn().mockRejectedValue(new Error("database locked")),
      },
    );

    expect(result.localPostRemoved).toBe(false);
    expect(deleteManagedMedia).not.toHaveBeenCalled();
  });

  it("distinguishes a canceled local Reel from an automatically retryable failure", async () => {
    const reel: Post = {
      ...draft,
      media: {
        type: "reel",
        source: {
          kind: "local",
          assetId: "asset-cancel.mp4",
          fileName: "cancel.mp4",
          mimeType: "video/mp4",
          size: 4096,
        },
        shareToFeed: true,
      },
    };

    await expect(
      publishPost(
        { accessToken: "token", igUserId: "account-7", post: reel, config: DEFAULT_CONFIG },
        { publishLocalReel: vi.fn().mockRejectedValue(new Error("Reel upload canceled.")) },
      ),
    ).rejects.toBeInstanceOf(PublishCanceledAfterContainerError);
  });

  it.each([
    ["a local file", "file:///Users/me/photo.jpg"],
    ["a blob URL", "blob:http://localhost/photo"],
    ["localhost", "http://localhost:3000/photo.jpg"],
    ["a private IPv4 address", "http://192.168.1.20/photo.jpg"],
    ["an IPv6 loopback address", "http://[::1]/photo.jpg"],
  ])("blocks %s before Instagram is mutated", async (_label, imageUrl) => {
    const publishImage = vi.fn();
    const fetchMedia = vi.fn();
    const verifyMediaUrl = vi.fn();

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: { ...draft, imageUrl },
          config: DEFAULT_CONFIG,
        },
        { verifyMediaUrl, publishImage, fetchMedia, removeLocalPost: vi.fn() },
      ),
    ).rejects.toThrow("publicly reachable http(s) URL");

    expect(publishImage).not.toHaveBeenCalled();
    expect(verifyMediaUrl).not.toHaveBeenCalled();
    expect(fetchMedia).not.toHaveBeenCalled();
  });

  it("rejects a post that Instagram already owns before publishing", async () => {
    const publishImage = vi.fn();
    const verifyMediaUrl = vi.fn();

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: { ...draft, status: "published" },
          config: DEFAULT_CONFIG,
        },
        {
          verifyMediaUrl,
          publishImage,
          fetchMedia: vi.fn(),
          removeLocalPost: vi.fn(),
        },
      ),
    ).rejects.toThrow("already published");

    expect(publishImage).not.toHaveBeenCalled();
    expect(verifyMediaUrl).not.toHaveBeenCalled();
  });

  it("blocks an unreachable public URL before Instagram is mutated", async () => {
    const verifyMediaUrl = vi
      .fn()
      .mockRejectedValue(
        new Error("Publishing requires a publicly reachable image URL; the media endpoint did not respond successfully."),
      );
    const publishImage = vi.fn();

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: draft,
          config: DEFAULT_CONFIG,
        },
        {
          verifyMediaUrl,
          publishImage,
          fetchMedia: vi.fn(),
          removeLocalPost: vi.fn(),
        },
      ),
    ).rejects.toThrow("publicly reachable image URL");

    expect(publishImage).not.toHaveBeenCalled();
  });

  it("marks an outward publishing error as ambiguous so callers do not retry blindly", async () => {
    const removeLocalPost = vi.fn();

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: draft,
          config: DEFAULT_CONFIG,
        },
        {
          verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
          publishImage: vi.fn().mockRejectedValue(new Error("response lost")),
          fetchMedia: vi.fn(),
          removeLocalPost,
        },
      ),
    ).rejects.toBeInstanceOf(PublishOutcomeUnknownError);

    expect(removeLocalPost).not.toHaveBeenCalled();
  });

  it("preserves the Instagram media ID when refreshing visible posts fails", async () => {
    const publishImage = vi.fn().mockResolvedValue("ig-42");
    const fetchMedia = vi.fn().mockRejectedValue(new Error("refresh unavailable"));
    const removeLocalPost = vi.fn().mockResolvedValue(undefined);

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: draft,
          config: DEFAULT_CONFIG,
        },
        {
          verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
          publishImage,
          fetchMedia,
          removeLocalPost,
        },
      ),
    ).resolves.toEqual({
      mediaId: "ig-42",
      publishedPosts: null,
      localPostRemoved: true,
      refreshError: "refresh unavailable",
    });
  });

  it("preserves the media ID and refreshes when local cleanup fails after publishing", async () => {
    const refreshed: Post[] = [{ ...draft, id: "ig-42", status: "published" }];

    await expect(
      publishPost(
        {
          accessToken: "token",
          igUserId: "account-7",
          post: draft,
          config: DEFAULT_CONFIG,
        },
        {
          verifyMediaUrl: vi.fn().mockResolvedValue(undefined),
          publishImage: vi.fn().mockResolvedValue("ig-42"),
          fetchMedia: vi.fn().mockResolvedValue(refreshed),
          removeLocalPost: vi.fn().mockRejectedValue(new Error("database locked")),
        },
      ),
    ).resolves.toEqual({
      mediaId: "ig-42",
      publishedPosts: refreshed,
      localPostRemoved: false,
      cleanupError: "database locked",
    });
  });
});
