import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.fn();
vi.mock("./app-database", () => ({ appDatabase: vi.fn(() => Promise.resolve({ select })) }));

import { loadStoredContent, loadStoredDeliveries } from "./content-delivery-storage";

beforeEach(() => select.mockReset());

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
});
