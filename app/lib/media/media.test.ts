import { describe, expect, it } from "vitest";
import { mediaForPost, newPostMedia } from "./media";
import type { Post } from "../shared/types";

const legacyPost: Post = {
  id: "legacy-1",
  imageUrl: "https://cdn.example.com/photo.jpg",
  caption: "Legacy",
  status: "draft",
};

describe("mediaForPost", () => {
  it("migrates a legacy URL-only post to an image URL media source", () => {
    expect(mediaForPost(legacyPost)).toEqual({
      type: "image",
      source: { kind: "url", url: "https://cdn.example.com/photo.jpg" },
    });
  });

  it("preserves a typed local Reel without exposing a filesystem path", () => {
    const media = newPostMedia({
      type: "reel",
      source: {
        kind: "local",
        assetId: "asset-42",
        fileName: "launch.mp4",
        mimeType: "video/mp4",
        size: 8_192,
      },
      shareToFeed: false,
    });

    expect(media).toEqual({
      type: "reel",
      source: {
        kind: "local",
        assetId: "asset-42",
        fileName: "launch.mp4",
        mimeType: "video/mp4",
        size: 8_192,
      },
      shareToFeed: false,
    });
    expect(JSON.stringify(media)).not.toContain("/Users/");
  });
});
