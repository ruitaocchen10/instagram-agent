import { describe, expect, it } from "vitest";
import {
  createDelivery,
  contentMediaForPost,
  validateDelivery,
  type Content,
  type PlatformAdapter,
} from "./social-content";
import { instagramAdapter } from "./platforms/instagram-adapter";

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
