import { describe, expect, it, vi } from "vitest";

const { savePost } = vi.hoisted(() => ({ savePost: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../persistence/storage", () => ({ savePost }));

import { createDraft } from "./drafts";

describe("createDraft", () => {
  it("saves a typed local Reel without requiring a public URL", async () => {
    const draft = await createDraft({
      caption: "Launch",
      media: {
        type: "reel",
        source: {
          kind: "local",
          assetId: "asset-7.mp4",
          fileName: "launch.mp4",
          mimeType: "video/mp4",
          size: 4096,
        },
        shareToFeed: true,
      },
    });

    expect(draft.imageUrl).toBe("");
    expect(draft.media?.type).toBe("reel");
    expect(savePost).toHaveBeenCalledWith(draft);
  });
});
