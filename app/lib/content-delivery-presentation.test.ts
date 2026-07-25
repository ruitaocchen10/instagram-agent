import { describe, expect, it } from "vitest";
import { groupContentDeliveries } from "./content-delivery-presentation";

describe("content delivery presentation", () => {
  it("groups destination-local states beneath reusable content", () => {
    expect(groupContentDeliveries([
      { id: "content-1", caption: "Base copy", media: { type: "image", source: { kind: "url", url: "https://cdn.example/a.jpg" } }, createdAt: 1, updatedAt: 2 },
    ], [
      { id: "delivery-a", contentId: "content-1", connectionId: "brand", platform: "instagram", status: "scheduled", scheduledAt: 10 },
      { id: "delivery-b", contentId: "content-1", connectionId: "personal", platform: "instagram", status: "draft" },
    ], [
      { id: "brand", platform: "instagram", displayName: "@brand", health: "ready", createdAt: 1, updatedAt: 1 },
      { id: "personal", platform: "instagram", displayName: "@personal", health: "ready", createdAt: 1, updatedAt: 1 },
    ])).toEqual([expect.objectContaining({
      content: expect.objectContaining({ id: "content-1" }),
      deliveries: [
        expect.objectContaining({ connectionName: "@brand", status: "scheduled" }),
        expect.objectContaining({ connectionName: "@personal", status: "draft" }),
      ],
    })]);
  });
});
