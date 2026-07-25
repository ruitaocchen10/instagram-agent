import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveComposedContent } = vi.hoisted(() => ({
  saveComposedContent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./content-delivery-storage", () => ({ saveComposedContent }));

import { prepareImmediateDelivery, saveDraftContent, scheduleContent } from "./scheduling";
import type { StoredContent } from "./content-delivery-storage";

const content: StoredContent = {
  id: "content-1",
  caption: "Base copy",
  media: { type: "image", source: { kind: "url", url: "https://cdn.example/a.jpg" } },
  createdAt: 10,
  updatedAt: 20,
};

const brand = {
  connection: {
    id: "instagram-brand",
    platform: "instagram",
    displayName: "@brand",
    health: "ready" as const,
    createdAt: 1,
    updatedAt: 1,
  },
};

const personal = {
  connection: { ...brand.connection, id: "instagram-personal", displayName: "@personal" },
};

beforeEach(() => saveComposedContent.mockClear());

describe("saveDraftContent", () => {
  it("keeps a creative with no destination chosen yet", async () => {
    await saveDraftContent({ content, destinations: [] });

    expect(saveComposedContent).toHaveBeenCalledWith(content, []);
  });

  it("records each chosen destination as an unscheduled delivery", async () => {
    await saveDraftContent({ content, destinations: [brand, personal] });

    const [, deliveries] = saveComposedContent.mock.calls[0];
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ connectionId: "instagram-brand", status: "draft" });
    expect(deliveries[0].scheduledAt).toBeUndefined();
  });
});

describe("scheduleContent", () => {
  it("gives every destination its own schedule", async () => {
    await scheduleContent({
      content,
      destinations: [brand, personal],
      at: 5_000,
      now: 1_000,
    });

    const [, deliveries] = saveComposedContent.mock.calls[0];
    expect(deliveries.map((delivery: { connectionId: string }) => delivery.connectionId)).toEqual([
      "instagram-brand",
      "instagram-personal",
    ]);
    for (const delivery of deliveries) {
      expect(delivery).toMatchObject({ status: "scheduled", scheduledAt: 5_000 });
    }
  });

  it("carries destination-local publishing options onto each delivery", async () => {
    await scheduleContent({
      content,
      destinations: [brand],
      at: 5_000,
      now: 1_000,
      platformOptions: { shareToFeed: false },
    });

    const [, deliveries] = saveComposedContent.mock.calls[0];
    expect(deliveries[0].platformOptions).toEqual({ shareToFeed: false });
  });

  it("refuses a time that has already passed", async () => {
    await expect(
      scheduleContent({ content, destinations: [brand], at: 1_000, now: 5_000 }),
    ).rejects.toThrow("must be in the future");

    expect(saveComposedContent).not.toHaveBeenCalled();
  });

  it("refuses an unreadable time", async () => {
    await expect(
      scheduleContent({ content, destinations: [brand], at: Number.NaN, now: 1_000 }),
    ).rejects.toThrow("valid date and time");
  });

  it("refuses to schedule content that is going nowhere", async () => {
    await expect(
      scheduleContent({ content, destinations: [], at: 5_000, now: 1_000 }),
    ).rejects.toThrow("at least one ready destination");
  });

  it("refuses a caption longer than the application limit", async () => {
    await expect(
      scheduleContent({
        content: { ...content, caption: "a".repeat(2_201) },
        destinations: [brand],
        at: 5_000,
        now: 1_000,
      }),
    ).rejects.toThrow("2200 characters or fewer");
  });
});

describe("prepareImmediateDelivery", () => {
  // Publishing now is the one case where an already-due delivery is correct:
  // the claim that prevents a duplicate publication has to exist first.
  it("persists an already-due delivery rather than rejecting the past time", async () => {
    const delivery = await prepareImmediateDelivery({
      content,
      destination: brand,
      at: 5_000,
    });

    expect(delivery).toMatchObject({
      connectionId: "instagram-brand",
      status: "scheduled",
      scheduledAt: 5_000,
    });
    expect(saveComposedContent).toHaveBeenCalledWith(content, [delivery]);
  });
});
