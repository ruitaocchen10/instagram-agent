import { describe, expect, it } from "vitest";
import { LEGACY_INSTAGRAM_CONNECTION_ID, migrateLegacyInstagramPost } from "./legacy-instagram-migration";

describe("legacy Instagram content/delivery migration", () => {
  it("preserves a scheduled local Reel as one reusable content item and one delivery", () => {
    const migration = migrateLegacyInstagramPost({
      id: "post-7",
      imageUrl: "",
      media: {
        type: "reel",
        source: {
          kind: "local",
          assetId: "asset-7",
          fileName: "launch.mp4",
          mimeType: "video/mp4",
          size: 2048,
        },
        shareToFeed: false,
      },
      caption: "Launch day",
      status: "scheduled",
      scheduledAt: 20_000,
      publishState: "failed",
      publishError: "Network interrupted",
      publishAttemptedAt: 19_000,
      publishAttemptCount: 2,
      updatedAt: 18_000,
    });

    expect(migration.content).toEqual({
      id: "post-7",
      caption: "Launch day",
      media: {
        type: "video",
        source: {
          kind: "local",
          assetId: "asset-7",
          fileName: "launch.mp4",
          mimeType: "video/mp4",
          size: 2048,
        },
      },
    });
    expect(migration.delivery).toMatchObject({
      id: "legacy-instagram-post-7",
      contentId: "post-7",
      connectionId: LEGACY_INSTAGRAM_CONNECTION_ID,
      platform: "instagram",
      status: "scheduled",
      scheduledAt: 20_000,
      publishState: "failed",
      failureKind: "retryable",
      publishError: "Network interrupted",
      publishAttemptedAt: 19_000,
      publishAttemptCount: 2,
      platformOptions: { shareToFeed: false },
    });
    expect(migration.updatedAt).toBe(18_000);
  });

  it("keeps a remote image URL and creates a draft delivery", () => {
    const { content, delivery } = migrateLegacyInstagramPost({
      id: "post-8",
      imageUrl: "https://cdn.example.com/photo.jpg",
      caption: "Photo",
      status: "draft",
    });

    expect(content.media).toEqual({
      type: "image",
      source: { kind: "url", url: "https://cdn.example.com/photo.jpg" },
    });
    expect(delivery).toMatchObject({ status: "draft" });
    expect(delivery.publishState).toBeUndefined();
    expect(delivery.platformOptions).toBeUndefined();
  });

  it("uses the recoverable legacy update time when an old post has no creation time", () => {
    expect(
      migrateLegacyInstagramPost({
        id: "post-9",
        imageUrl: "https://cdn.example.com/photo.jpg",
        caption: "Photo",
        status: "draft",
        updatedAt: 42,
      }).updatedAt,
    ).toBe(42);
  });
});
