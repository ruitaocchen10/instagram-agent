import { describe, expect, it, vi } from "vitest";
import {
  PublishAuthenticationError,
  PublishCanceledAfterContainerError,
  PublishOutcomeUnknownError,
  publishDelivery,
} from "./publishing";
import type {
  Content,
  ContentMedia,
  Delivery,
  PublishedItem,
  SocialPlatformAdapter,
} from "./social-content";

const IMAGE_URL = "https://cdn.example.com/launch.jpg";

const content: Content = {
  id: "content-1",
  caption: "The launch starts here.",
  media: { type: "image", source: { kind: "url", url: IMAGE_URL } },
};

const delivery: Delivery = {
  id: "delivery-1",
  contentId: "content-1",
  connectionId: "instagram-brand",
  platform: "instagram",
  status: "scheduled",
  scheduledAt: 1_000,
  publishState: "claimed",
};

function withMedia(media: ContentMedia): Content {
  return { ...content, media };
}

const localImage = withMedia({
  type: "image",
  source: {
    kind: "local",
    assetId: "asset-1.jpg",
    fileName: "photo.png",
    mimeType: "image/jpeg",
    size: 2048,
  },
});

// A stand-in adapter keeps these tests about the platform-neutral publisher:
// validation, media preparation, cleanup, and failure mapping. Instagram's own
// dispatch is covered in platforms/instagram-adapter.test.ts, and the connection
// half of the adapter is exercised through connection-lifecycle.test.ts.
function fakeAdapter(overrides: Partial<SocialPlatformAdapter> = {}): SocialPlatformAdapter {
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

function publish(
  overrides: Partial<Parameters<typeof publishDelivery>[0]> = {},
  dependencies: Parameters<typeof publishDelivery>[1] = {},
) {
  return publishDelivery(
    {
      content,
      delivery,
      accessToken: "token",
      externalIdentityId: "account-7",
      ...overrides,
    },
    dependencies,
  );
}

describe("publishDelivery", () => {
  it("publishes an eligible delivery and returns its external ID with the refreshed feed", async () => {
    const refreshed: PublishedItem[] = [
      { externalId: "ig-42", caption: content.caption, previewUrl: IMAGE_URL },
    ];
    const adapter = fakeAdapter({ fetchPublishedContent: vi.fn().mockResolvedValue(refreshed) });
    const verifyMediaUrl = vi.fn().mockResolvedValue(undefined);
    const beforePublish = vi.fn().mockResolvedValue(undefined);

    await expect(
      publish({ beforePublish }, { verifyMediaUrl, resolveAdapter: () => adapter }),
    ).resolves.toEqual({ externalId: "ig-42", publishedContent: refreshed });

    expect(verifyMediaUrl).toHaveBeenCalledWith(IMAGE_URL);
    expect(adapter.publish).toHaveBeenCalledWith({
      media: { type: "image", kind: "public-url", url: IMAGE_URL },
      caption: content.caption,
      credentials: { accessToken: "token", externalIdentityId: "account-7" },
      lifecycle: { onProcessing: expect.any(Function), onPublishing: expect.any(Function) },
    });

    // The claim recorded by `beforePublish` must be durable before anything is
    // sent outward, and the feed is only re-read once publication succeeded.
    const publishCall = vi.mocked(adapter.publish);
    const fetchPublishedContent = vi.mocked(adapter.fetchPublishedContent!);
    expect(verifyMediaUrl.mock.invocationCallOrder[0]).toBeLessThan(
      beforePublish.mock.invocationCallOrder[0],
    );
    expect(beforePublish.mock.invocationCallOrder[0]).toBeLessThan(
      publishCall.mock.invocationCallOrder[0],
    );
    expect(publishCall.mock.invocationCallOrder[0]).toBeLessThan(
      fetchPublishedContent.mock.invocationCallOrder[0],
    );
  });

  it("routes the publication to the adapter registered for the delivery's platform", async () => {
    const resolveAdapter = vi.fn().mockReturnValue(fakeAdapter());

    await publish({}, { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter });

    expect(resolveAdapter).toHaveBeenCalledWith("instagram");
  });

  it("sends this destination's caption override rather than the base copy", async () => {
    const adapter = fakeAdapter();

    await publish(
      { delivery: { ...delivery, captionOverride: "Brand copy" } },
      { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter },
    );

    expect(adapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ caption: "Brand copy" }),
    );
  });

  it("refuses a delivery that belongs to different content", async () => {
    const adapter = fakeAdapter();

    await expect(
      publish(
        { delivery: { ...delivery, contentId: "content-other" } },
        { resolveAdapter: () => adapter },
      ),
    ).rejects.toThrow("does not belong to the content");

    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("stages local media the platform must fetch, then reclaims only the staged copy", async () => {
    const adapter = fakeAdapter();
    const stageLocalImage = vi.fn().mockResolvedValue({
      objectKey: "socialite/account-7/object.jpg",
      publicUrl: "https://r2.example.com/signed-image",
    });
    const deleteStagedMedia = vi.fn().mockResolvedValue(undefined);

    await publish(
      { content: localImage },
      { resolveAdapter: () => adapter, stageLocalImage, deleteStagedMedia },
    );

    expect(stageLocalImage).toHaveBeenCalledWith("asset-1.jpg", "account-7");
    expect(adapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { type: "image", kind: "public-url", url: "https://r2.example.com/signed-image" },
      }),
    );
    expect(deleteStagedMedia).toHaveBeenCalledWith("socialite/account-7/object.jpg");
  });

  it("hands a local asset straight to an adapter that uploads that media type itself", async () => {
    const reel = withMedia({
      type: "video",
      source: {
        kind: "local",
        assetId: "asset-2.mp4",
        fileName: "launch.mp4",
        mimeType: "video/mp4",
        size: 4096,
      },
    });
    const adapter = fakeAdapter();
    const stageLocalImage = vi.fn();

    await publish(
      { content: reel, delivery: { ...delivery, platformOptions: { shareToFeed: false } } },
      { resolveAdapter: () => adapter, stageLocalImage },
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
    const reel = withMedia({
      type: "video",
      source: {
        kind: "local",
        assetId: "asset-3.mp4",
        fileName: "launch.mp4",
        mimeType: "video/mp4",
        size: 4096,
      },
    });
    const stageLocalImage = vi.fn();

    await expect(
      publish({ content: reel }, { resolveAdapter: () => adapter, stageLocalImage }),
    ).rejects.toThrow("Instagram cannot publish a local video yet");

    expect(stageLocalImage).not.toHaveBeenCalled();
    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("distinguishes a canceled upload from an automatically retryable failure", async () => {
    const adapter = fakeAdapter({
      publish: vi.fn().mockRejectedValue(new Error("Reel upload canceled.")),
      classifyPublishFailure: () => "canceled",
    });

    await expect(
      publish({}, { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter }),
    ).rejects.toBeInstanceOf(PublishCanceledAfterContainerError);
  });

  it.each([
    ["a local file", "file:///Users/me/photo.jpg"],
    ["a blob URL", "blob:http://localhost/photo"],
    ["localhost", "http://localhost:3000/photo.jpg"],
    ["a private IPv4 address", "http://192.168.1.20/photo.jpg"],
    ["an IPv6 loopback address", "http://[::1]/photo.jpg"],
  ])("blocks %s before the platform is mutated", async (_label, url) => {
    const adapter = fakeAdapter();
    const verifyMediaUrl = vi.fn();

    await expect(
      publish(
        { content: withMedia({ type: "image", source: { kind: "url", url } }) },
        { verifyMediaUrl, resolveAdapter: () => adapter },
      ),
    ).rejects.toThrow("publicly reachable http(s) URL");

    expect(adapter.publish).not.toHaveBeenCalled();
    expect(adapter.fetchPublishedContent).not.toHaveBeenCalled();
    expect(verifyMediaUrl).not.toHaveBeenCalled();
  });

  it("rejects a delivery the platform already owns before publishing", async () => {
    const adapter = fakeAdapter();
    const verifyMediaUrl = vi.fn();

    await expect(
      publish(
        { delivery: { ...delivery, status: "published" } },
        { verifyMediaUrl, resolveAdapter: () => adapter },
      ),
    ).rejects.toThrow("already been published");

    expect(adapter.publish).not.toHaveBeenCalled();
    expect(verifyMediaUrl).not.toHaveBeenCalled();
  });

  it("enforces the adapter's declared caption limit", async () => {
    const adapter = fakeAdapter();

    await expect(
      publish(
        { content: { ...content, caption: "a".repeat(2201) } },
        { resolveAdapter: () => adapter },
      ),
    ).rejects.toThrow("The caption for this destination must be 2200 characters or fewer.");

    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("refuses a media type the adapter does not declare support for", async () => {
    const adapter = fakeAdapter({
      capabilities: { mediaTypes: ["image"], maxCaptionLength: 2200 },
    });

    await expect(
      publish(
        { content: withMedia({ type: "video", source: { kind: "url", url: IMAGE_URL } }) },
        { resolveAdapter: () => adapter },
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

    await expect(publish({}, { verifyMediaUrl, resolveAdapter: () => adapter })).rejects.toThrow(
      "publicly reachable image URL",
    );

    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("marks an outward publishing error as ambiguous so callers do not retry blindly", async () => {
    const adapter = fakeAdapter({
      publish: vi.fn().mockRejectedValue(new Error("response lost")),
      classifyPublishFailure: () => "uncertain",
    });

    const error = await publish(
      {},
      { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublishOutcomeUnknownError);
    expect((error as PublishOutcomeUnknownError).message).toContain(
      "Instagram did not return a definitive publishing result",
    );
  });

  it("preserves an authentication rejection so the affected connection can require reconnection", async () => {
    const platformError = new Error("Token expired");
    const adapter = fakeAdapter({
      publish: vi.fn().mockRejectedValue(platformError),
      classifyPublishFailure: () => "authentication",
    });

    const error = await publish(
      {},
      { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublishAuthenticationError);
    expect((error as PublishAuthenticationError).cause).toBe(platformError);
    expect((error as PublishAuthenticationError).message).toBe("Token expired");
  });

  it("preserves the external ID when refreshing the published feed fails", async () => {
    const adapter = fakeAdapter({
      fetchPublishedContent: vi.fn().mockRejectedValue(new Error("refresh unavailable")),
    });

    await expect(
      publish({}, { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter }),
    ).resolves.toEqual({
      externalId: "ig-42",
      publishedContent: null,
      refreshError: "refresh unavailable",
    });
  });

  it("reports no published feed for a platform that does not offer that read", async () => {
    const adapter = fakeAdapter({
      publishedRead: { publishedHistory: false, metrics: [] },
      fetchPublishedContent: vi.fn(),
    });

    await expect(
      publish({}, { verifyMediaUrl: vi.fn().mockResolvedValue(undefined), resolveAdapter: () => adapter }),
      // The publication itself still succeeded, and an unread feed is not an
      // error to report against it.
    ).resolves.toEqual({ externalId: "ig-42", publishedContent: null });

    expect(adapter.fetchPublishedContent).not.toHaveBeenCalled();
  });

  it("preserves the external ID and refreshes when staged media cannot be reclaimed", async () => {
    const refreshed: PublishedItem[] = [{ externalId: "ig-42", caption: content.caption }];
    const adapter = fakeAdapter({ fetchPublishedContent: vi.fn().mockResolvedValue(refreshed) });

    await expect(
      publish(
        { content: localImage },
        {
          resolveAdapter: () => adapter,
          stageLocalImage: vi.fn().mockResolvedValue({
            objectKey: "socialite/account-7/object.jpg",
            publicUrl: "https://r2.example.com/signed-image",
          }),
          deleteStagedMedia: vi.fn().mockRejectedValue(new Error("R2 unavailable")),
        },
      ),
    ).resolves.toEqual({
      externalId: "ig-42",
      publishedContent: refreshed,
      cleanupError: "temporary R2 media could not be deleted: Error: R2 unavailable",
    });
  });
});
