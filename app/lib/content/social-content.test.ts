import { describe, expect, it } from "vitest";
import {
  claimScheduledDelivery,
  createDelivery,
  contentMediaForPost,
  deliveryFlag,
  dueScheduledDeliveries,
  markDeliveryPublishing,
  recordDeliveryFailure,
  recordDeliveryOutcomeUnknown,
  recordDeliveryPublished,
  validateDelivery,
  type Content,
  type PlatformAdapter,
} from "./social-content";
import { instagramAdapter } from "../platforms/instagram-adapter";

const content: Content = {
  id: "content-1",
  caption: "A launch announcement",
  media: { type: "image", source: { kind: "url", url: "https://cdn.example/launch.jpg" } },
};

const imageOnlyAdapter: PlatformAdapter = {
  platform: "instagram",
  capabilities: {
    mediaTypes: ["image"],
    maxCaptionLength: 30,
  },
};

describe("content and delivery seam", () => {
  it("schedules and claims one delivery without affecting another destination", () => {
    const due = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
      status: "scheduled",
      scheduledAt: 10_000,
    });
    const later = createDelivery({
      id: "delivery-x",
      contentId: content.id,
      connectionId: "connection-x",
      platform: "x",
      status: "scheduled",
      scheduledAt: 10_001,
    });

    expect(dueScheduledDeliveries([due, later], 10_000)).toEqual([due]);
    expect(claimScheduledDelivery(due, 10_000)).toMatchObject({
      id: due.id,
      publishState: "claimed",
      publishAttemptedAt: 10_000,
      publishAttemptCount: 1,
    });
  });

  it("keeps an uncertain delivery out of automatic retries", () => {
    const scheduled = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
      status: "scheduled",
      scheduledAt: 10_000,
    });
    const publishing = markDeliveryPublishing(claimScheduledDelivery(scheduled, 10_000), 10_001);
    const uncertain = recordDeliveryOutcomeUnknown(publishing, "Connection closed", 10_002);

    expect(uncertain).toMatchObject({
      publishState: "uncertain",
      publishError: "Connection closed",
    });
    expect(dueScheduledDeliveries([uncertain], 99_999)).toEqual([]);
  });

  it("records the platform result when a scheduled delivery is published", () => {
    const scheduled = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
      status: "scheduled",
      scheduledAt: 10_000,
    });

    expect(
      recordDeliveryPublished(
        markDeliveryPublishing(claimScheduledDelivery(scheduled, 10_000), 10_001),
        { id: "ig-media-42", permalink: "https://instagram.example/p/42" },
        10_002,
      ),
    ).toMatchObject({
      status: "published",
      publishedAt: 10_002,
      externalResult: { id: "ig-media-42", permalink: "https://instagram.example/p/42" },
    });
  });

  it("records a definitive success when a platform has no result link", () => {
    const scheduled = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
      status: "scheduled",
      scheduledAt: 10_000,
    });

    expect(
      recordDeliveryPublished(
        markDeliveryPublishing(claimScheduledDelivery(scheduled, 10_000), 10_001),
        undefined,
        10_002,
      ),
    ).toMatchObject({ status: "published", publishedAt: 10_002 });
  });

  it("does not automatically retry an authentication failure", () => {
    const scheduled = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
      status: "scheduled",
      scheduledAt: 10_000,
    });
    const failed = recordDeliveryFailure(
      markDeliveryPublishing(claimScheduledDelivery(scheduled, 10_000), 10_001),
      "Reconnect the connection before publishing.",
      10_002,
      "authentication",
    );

    expect(failed).toMatchObject({ publishState: "failed", failureKind: "authentication" });
    expect(dueScheduledDeliveries([failed], 99_999)).toEqual([]);
  });

  it("keeps an Instagram Reel's feed choice out of reusable content", () => {
    const media = contentMediaForPost({
      imageUrl: "",
      media: {
        type: "reel",
        source: { kind: "url", url: "https://cdn.example/launch.mp4" },
        shareToFeed: false,
      },
    });

    expect(media).toEqual({
      type: "video",
      source: { kind: "url", url: "https://cdn.example/launch.mp4" },
    });
  });

  it("describes the current Instagram publishing formats through the shared capability contract", () => {
    expect(instagramAdapter).toMatchObject({
      platform: "instagram",
      capabilities: { mediaTypes: ["image", "video"], maxCaptionLength: 2200 },
    });
  });

  it("keeps destination-specific caption overrides on independent deliveries", () => {
    const instagram = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
    });
    const shortened = createDelivery({
      id: "delivery-x",
      contentId: content.id,
      connectionId: "connection-x",
      platform: "x",
      captionOverride: "Launch now",
    });

    expect(instagram.captionOverride).toBeUndefined();
    expect(shortened.captionOverride).toBe("Launch now");
    expect(content.caption).toBe("A launch announcement");
  });

  it("reports a delivery-local capability error without rejecting another destination", () => {
    const ready = createDelivery({
      id: "delivery-ig",
      contentId: content.id,
      connectionId: "connection-ig",
      platform: "instagram",
    });
    const tooLong = createDelivery({
      id: "delivery-x",
      contentId: content.id,
      connectionId: "connection-x",
      platform: "instagram",
      captionOverride: "This caption is deliberately longer than thirty characters.",
    });

    expect(validateDelivery(content, ready, imageOnlyAdapter)).toEqual([]);
    expect(validateDelivery(content, tooLong, imageOnlyAdapter)).toEqual([
      {
        field: "caption",
        message: "Instagram captions must be 30 characters or fewer.",
      },
    ]);
  });

  it("rejects a delivery whose platform does not match its adapter", () => {
    const delivery = createDelivery({
      id: "delivery-x",
      contentId: content.id,
      connectionId: "connection-x",
      platform: "x",
    });

    expect(validateDelivery(content, delivery, imageOnlyAdapter)).toEqual([
      {
        field: "connection",
        message: "This delivery targets X but the selected adapter is Instagram.",
      },
    ]);
  });
});

describe("reading a delivery's platform flags", () => {
  it("takes a boolean at face value", () => {
    expect(deliveryFlag({ shareToFeed: false }, "shareToFeed", true)).toBe(false);
    expect(deliveryFlag({ shareToFeed: true }, "shareToFeed", false)).toBe(true);
  });

  // SQLite's JSON has no boolean type, so a migrated option arrives as 0 or 1.
  it("reads SQLite's numeric booleans the way they were written", () => {
    expect(deliveryFlag({ shareToFeed: 0 }, "shareToFeed", true)).toBe(false);
    expect(deliveryFlag({ shareToFeed: 1 }, "shareToFeed", false)).toBe(true);
  });

  it("falls back only when the option was never recorded", () => {
    expect(deliveryFlag(undefined, "shareToFeed", true)).toBe(true);
    expect(deliveryFlag({}, "shareToFeed", false)).toBe(false);
  });
});
