import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.fn();
const execute = vi.fn();
vi.mock("./app-database", () => ({ appDatabase: vi.fn(() => Promise.resolve({ select, execute })) }));

import {
  claimStoredDelivery,
  deleteStoredContent,
  failStoredDelivery,
  loadStoredContent,
  loadStoredDeliveries,
  markStoredDeliveryUncertain,
  saveComposedContent,
  startStoredDelivery,
} from "./content-delivery-storage";

beforeEach(() => {
  select.mockReset();
  execute.mockReset();
});

describe("content and delivery storage", () => {
  it("reads migrated content without reintroducing an Instagram format", async () => {
    select.mockResolvedValueOnce([
      {
        id: "post-7",
        caption: "Launch",
        media_json: JSON.stringify({ type: "video", source: { kind: "url", url: "https://cdn.example/launch.mp4" } }),
        created_at: 10,
        updated_at: 20,
      },
    ]);

    await expect(loadStoredContent()).resolves.toEqual([
      {
        id: "post-7",
        caption: "Launch",
        media: { type: "video", source: { kind: "url", url: "https://cdn.example/launch.mp4" } },
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
  });

  it("keeps each migrated delivery's lifecycle and Instagram options local to that delivery", async () => {
    select.mockResolvedValueOnce([
      {
        id: "legacy-instagram-post-7",
        content_id: "post-7",
        connection_id: "legacy-instagram-default",
        platform: "instagram",
        caption_override: null,
        platform_options_json: JSON.stringify({ shareToFeed: false }),
        status: "scheduled",
        scheduled_at: 20,
        publish_state: "failed",
        publish_error: "Network interrupted",
        failure_kind: "retryable",
        publish_attempted_at: 19,
        publish_attempt_count: 2,
        published_at: null,
        external_result_json: null,
      },
    ]);

    await expect(loadStoredDeliveries("post-7")).resolves.toEqual([
      expect.objectContaining({
        id: "legacy-instagram-post-7",
        contentId: "post-7",
        platformOptions: { shareToFeed: false },
        publishState: "failed",
        failureKind: "retryable",
        publishAttemptCount: 2,
      }),
    ]);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("WHERE content_id = $1"), ["post-7"]);
  });

  it("claims a due delivery atomically before changing its lifecycle", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 1 });
    const delivery = {
      id: "delivery-7",
      contentId: "content-7",
      connectionId: "connection-7",
      platform: "instagram",
      status: "scheduled" as const,
      scheduledAt: 10,
    };

    await expect(claimStoredDelivery(delivery, 20)).resolves.toMatchObject({
      publishState: "claimed",
      publishAttemptCount: 1,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE deliveries SET publish_state = 'claimed'"),
      ["delivery-7", 10, 20],
    );
  });

  it("only records an uncertain outcome from an active delivery claim", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 1 });
    const claimed = {
      id: "delivery-7",
      contentId: "content-7",
      connectionId: "connection-7",
      platform: "instagram",
      status: "scheduled" as const,
      scheduledAt: 10,
      publishState: "claimed" as const,
      publishAttemptedAt: 20,
      publishAttemptCount: 1,
    };
    const publishing = await startStoredDelivery(claimed, 21);
    execute.mockResolvedValueOnce({ rowsAffected: 1 });

    await expect(markStoredDeliveryUncertain(publishing, "Connection closed", 22)).resolves.toMatchObject({
      publishState: "uncertain",
      publishError: "Connection closed",
    });
    expect(execute.mock.calls.at(-1)?.[0]).toContain("publish_state IN ($12, $13)");
  });

  it("records a connection failure as non-retryable authentication work", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 1 });
    const claimed = {
      id: "delivery-7",
      contentId: "content-7",
      connectionId: "connection-7",
      platform: "instagram",
      status: "scheduled" as const,
      scheduledAt: 10,
      publishState: "claimed" as const,
      publishAttemptedAt: 20,
      publishAttemptCount: 1,
    };

    await expect(
      failStoredDelivery(claimed, "Reconnect @brand before publishing.", 21, "authentication"),
    ).resolves.toMatchObject({
      publishState: "failed",
      failureKind: "authentication",
    });
  });

  it("deletes content together with the deliveries that pointed at it", async () => {
    select.mockResolvedValueOnce([{ n: 0 }]);
    execute.mockResolvedValue({ rowsAffected: 1 });

    await deleteStoredContent("content-7");

    expect(execute.mock.calls[0]).toEqual([
      "DELETE FROM deliveries WHERE content_id = $1",
      ["content-7"],
    ]);
    expect(execute.mock.calls[1]).toEqual(["DELETE FROM contents WHERE id = $1", ["content-7"]]);
  });

  it("refuses to delete content a destination has already claimed for publishing", async () => {
    select.mockResolvedValueOnce([{ n: 1 }]);

    await expect(deleteStoredContent("content-7")).rejects.toThrow("already publishing this content");
    expect(execute).not.toHaveBeenCalled();
  });

  it("saves destination-local overrides and removes an obsolete non-published delivery", async () => {
    execute.mockResolvedValue({ rowsAffected: 1 });
    await saveComposedContent({
      id: "content-7", caption: "Base copy",
      media: { type: "image", source: { kind: "url", url: "https://cdn.example/image.jpg" } },
      createdAt: 10, updatedAt: 20,
    }, [{
      id: "delivery-brand", contentId: "content-7", connectionId: "instagram-brand",
      platform: "instagram", captionOverride: "Brand copy", status: "draft",
    }]);

    expect(execute.mock.calls[1]).toEqual([
      expect.stringContaining("INSERT INTO deliveries"),
      expect.arrayContaining(["delivery-brand", "content-7", "instagram-brand", "Brand copy"]),
    ]);
    expect(execute.mock.calls[2]).toEqual([
      expect.stringContaining("DELETE FROM deliveries WHERE content_id = $1"),
      ["content-7", "delivery-brand"],
    ]);
  });
});
