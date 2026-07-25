import { describe, expect, it } from "vitest";
import {
  contentDeletionConfirmation,
  deliveryState,
  groupContentDeliveries,
  groupsWithStatus,
  scheduledDeliveries,
} from "./content-delivery-presentation";
import type { StoredContent } from "./content-delivery-storage";
import type { Delivery } from "./social-content";

const CONNECTIONS = [
  { id: "brand", platform: "instagram", displayName: "@brand", health: "ready" as const, createdAt: 1, updatedAt: 1 },
  { id: "personal", platform: "instagram", displayName: "@personal", health: "ready" as const, createdAt: 1, updatedAt: 1 },
];

const CONTENT: StoredContent = {
  id: "content-1",
  caption: "Base copy",
  media: { type: "image", source: { kind: "url", url: "https://cdn.example/a.jpg" } },
  createdAt: 1,
  updatedAt: 2,
};

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: "delivery-a",
    contentId: "content-1",
    connectionId: "brand",
    platform: "instagram",
    status: "scheduled",
    scheduledAt: 10,
    ...overrides,
  };
}

describe("content delivery presentation", () => {
  it("groups destination-local states beneath reusable content", () => {
    expect(groupContentDeliveries([CONTENT], [
      delivery(),
      delivery({ id: "delivery-b", connectionId: "personal", status: "draft", scheduledAt: undefined }),
    ], CONNECTIONS)).toEqual([expect.objectContaining({
      content: expect.objectContaining({ id: "content-1" }),
      previewUrl: "https://cdn.example/a.jpg",
      deliveries: [
        expect.objectContaining({ connectionName: "@brand", status: "scheduled" }),
        expect.objectContaining({ connectionName: "@personal", status: "draft" }),
      ],
    })]);
  });

  it("resolves a preview for managed local media the platform never hosted", () => {
    const [group] = groupContentDeliveries(
      [{ ...CONTENT, media: { type: "video", source: { kind: "local", assetId: "asset-1", fileName: "reel.mp4", mimeType: "video/mp4", size: 12 } } }],
      [],
      CONNECTIONS,
      new Map([["asset-1", "asset://preview/reel.mp4"]]),
    );

    expect(group.previewUrl).toBe("asset://preview/reel.mp4");
  });

  it("lists content wherever its destinations put it, and keeps destination-less content a draft", () => {
    const groups = groupContentDeliveries(
      [CONTENT, { ...CONTENT, id: "content-2", updatedAt: 1 }],
      [delivery(), delivery({ id: "delivery-b", connectionId: "personal", status: "draft", scheduledAt: undefined })],
      CONNECTIONS,
    );

    expect(groupsWithStatus(groups, "scheduled").map((group) => group.content.id)).toEqual(["content-1"]);
    expect(groupsWithStatus(groups, "draft").map((group) => group.content.id)).toEqual([
      "content-1",
      "content-2",
    ]);
  });

  it("plots one calendar entry per scheduled delivery, in publishing order", () => {
    const groups = groupContentDeliveries([CONTENT], [
      delivery({ id: "delivery-late", scheduledAt: 30 }),
      delivery({ id: "delivery-early", connectionId: "personal", scheduledAt: 20 }),
      delivery({ id: "delivery-draft", status: "draft", scheduledAt: undefined }),
    ], CONNECTIONS);

    expect(scheduledDeliveries(groups).map((entry) => entry.delivery.id)).toEqual([
      "delivery-early",
      "delivery-late",
    ]);
  });

  it("separates a retryable failure from work that is waiting on the creator", () => {
    expect(deliveryState(delivery({ publishState: "failed", publishError: "Network interrupted" }))).toMatchObject({
      tone: "error",
      label: "Publish failed",
      detail: "Network interrupted. Retrying automatically.",
    });
    // The platform's own text may already end its sentence.
    expect(
      deliveryState(delivery({ publishState: "failed", publishError: "Network interrupted." })).detail,
    ).toBe("Network interrupted. Retrying automatically.");
    expect(
      deliveryState(delivery({ publishState: "failed", failureKind: "authentication", publishError: "Reconnect @brand before publishing." })),
    ).toMatchObject({ tone: "error", label: "Reconnect needed" });
    expect(deliveryState(delivery({ publishState: "publishing" }))).toMatchObject({
      tone: "pending",
      label: "Publishing",
    });
    expect(deliveryState(delivery({ status: "draft", scheduledAt: undefined }))).toMatchObject({
      label: "Not scheduled",
    });
    expect(deliveryState(delivery({ status: "published", scheduledAt: undefined }))).toMatchObject({
      tone: "success",
      label: "Published",
    });
  });

  it("names the platform to check when an outcome is unknown", () => {
    const state = deliveryState(delivery({ publishState: "uncertain", publishError: "Connection closed." }));

    expect(state).toMatchObject({ tone: "warning", label: "Outcome unknown" });
    expect(state.detail).toContain("Check Instagram before rescheduling");
  });

  it("warns about every destination that may already have published before deleting", () => {
    const [group] = groupContentDeliveries([CONTENT], [
      delivery({ publishState: "uncertain" }),
      delivery({ id: "delivery-b", connectionId: "personal" }),
    ], CONNECTIONS);

    expect(contentDeletionConfirmation(group)).toContain("@brand may already have published");
  });

  it("says which destinations a scheduled deletion cancels", () => {
    const [group] = groupContentDeliveries([CONTENT], [
      delivery(),
      delivery({ id: "delivery-b", connectionId: "personal" }),
    ], CONNECTIONS);

    expect(contentDeletionConfirmation(group)).toBe(
      "Delete this content and cancel publishing to @brand and @personal? This can't be undone.",
    );
  });

  it("keeps a plain draft deletion plain", () => {
    const [group] = groupContentDeliveries([CONTENT], [
      delivery({ status: "draft", scheduledAt: undefined }),
    ], CONNECTIONS);

    expect(contentDeletionConfirmation(group)).toBe("Delete this draft? This can't be undone.");
  });
});
