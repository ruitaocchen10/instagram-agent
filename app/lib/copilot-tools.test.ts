import { describe, expect, it } from "vitest";
import { listPostsForCopilot } from "./copilot-tools";

describe("listPostsForCopilot", () => {
  it("exposes safe local-media metadata without its preview URL or path", () => {
    const result = listPostsForCopilot([
      {
        id: "draft-1",
        imageUrl: "asset://localhost/Users/creator/private/reel.mp4",
        media: {
          type: "reel",
          source: {
            kind: "local",
            assetId: "managed-id.mp4",
            fileName: "launch-reel.mp4",
            mimeType: "video/mp4",
            size: 42,
          },
          shareToFeed: true,
        },
        caption: "Launch",
        status: "draft",
      },
    ]);

    expect(result.posts[0]).toMatchObject({
      image_url: "",
      media_type: "reel",
      media_source: "local",
      media_name: "launch-reel.mp4",
    });
    expect(JSON.stringify(result)).not.toContain("/Users/creator");
    expect(JSON.stringify(result)).not.toContain("managed-id.mp4");
  });
});
