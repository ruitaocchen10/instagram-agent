import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
const select = vi.fn();

vi.mock("./app-database", () => ({
  appDatabase: vi.fn(() => Promise.resolve({ execute, select })),
  inTransaction: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { loadPosts, savePost } from "./storage";
import type { Post } from "./types";

beforeEach(() => {
  execute.mockClear();
  select.mockReset();
});

describe("post media storage", () => {
  it("restores typed local media without persisting a filesystem path", async () => {
    select.mockResolvedValueOnce([
      {
        id: "reel-1",
        image_url: "",
        media_json: JSON.stringify({
          type: "reel",
          source: {
            kind: "local",
            assetId: "asset-1",
            fileName: "launch.mp4",
            mimeType: "video/mp4",
            size: 1024,
          },
          shareToFeed: true,
        }),
        caption: "Launch",
        status: "draft",
        scheduled_at: null,
        published_at: null,
        likes: null,
        comments: null,
        updated_at: 10,
        publish_state: "idle",
        publish_error: null,
        publish_attempted_at: null,
      },
    ]);

    const posts = await loadPosts();

    expect(posts[0].media).toEqual({
      type: "reel",
      source: {
        kind: "local",
        assetId: "asset-1",
        fileName: "launch.mp4",
        mimeType: "video/mp4",
        size: 1024,
      },
      shareToFeed: true,
    });
  });

  it("persists typed media as JSON alongside the legacy preview URL", async () => {
    const post: Post = {
      id: "image-1",
      imageUrl: "",
      media: {
        type: "image",
        source: {
          kind: "local",
          assetId: "asset-2",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          size: 2048,
        },
      },
      caption: "Photo",
      status: "draft",
    };

    await savePost(post);

    const params = execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO posts"))?.[1] as unknown[];
    expect(params).toContain(JSON.stringify(post.media));
    expect(JSON.stringify(params)).not.toContain("/Users/");
  });
});
