import { describe, expect, it } from "vitest";
import {
  deliveryForComposerDestination,
  preflightComposerDestinations,
} from "./delivery-composer";

const content = {
  id: "content-1",
  caption: "A launch announcement",
  media: { type: "image" as const, source: { kind: "url" as const, url: "https://cdn.example/launch.jpg" } },
};

describe("composer destination preflight", () => {
  it("keeps a caption override on its delivery instead of reusable content", () => {
    expect(deliveryForComposerDestination(content.id, {
      connection: { id: "instagram-brand", platform: "instagram", displayName: "@brand", health: "ready" },
      captionOverride: "Short launch copy",
    })).toMatchObject({
      contentId: content.id,
      connectionId: "instagram-brand",
      captionOverride: "Short launch copy",
    });
    expect(content.caption).toBe("A launch announcement");
  });

  it("reports validation per destination without blocking a ready destination", () => {
    const result = preflightComposerDestinations(content, [
      { connection: { id: "ready", platform: "instagram", displayName: "@ready", health: "ready" } },
      {
        connection: {
          id: "short", platform: "instagram", displayName: "@short", health: "ready",
          capabilities: { mediaTypes: ["image"], maxCaptionLength: 10 },
        },
      },
    ]);

    expect(result).toEqual([
      { connectionId: "ready", errors: [] },
      expect.objectContaining({
        connectionId: "short",
        errors: [{ field: "caption", message: "Instagram captions must be 10 characters or fewer." }],
      }),
    ]);
  });

  it("requires a ready connection and an installed adapter", () => {
    expect(preflightComposerDestinations(content, [
      { connection: { id: "expired", platform: "instagram", displayName: "@expired", health: "attention" } },
      { connection: { id: "future", platform: "tiktok", displayName: "@future", health: "ready" } },
    ])).toEqual([
      { connectionId: "expired", errors: [{ field: "connection", message: "@expired needs to be reconnected before publishing." }] },
      { connectionId: "future", errors: [{ field: "connection", message: "Tiktok is not available for publishing yet." }] },
    ]);
  });
});
