import { describe, expect, it, vi } from "vitest";

const { saveComposedContent } = vi.hoisted(() => ({
  saveComposedContent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./content-delivery-storage", () => ({ saveComposedContent }));

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
    // The creative is stored platform-neutrally: a Reel is video content, and
    // whether it also reaches the feed is a destination's choice, not the draft's.
    const [content, deliveries] = saveComposedContent.mock.calls[0];
    expect(content).toMatchObject({
      id: draft.id,
      caption: "Launch",
      media: { type: "video", source: { kind: "local", assetId: "asset-7.mp4" } },
    });
    expect(deliveries).toEqual([]);
  });

  it("rejects draft media that is not a usable URL", async () => {
    await expect(createDraft({ caption: "Launch", imageUrl: "not-a-url" })).rejects.toThrow(
      "Draft media must be a valid URL.",
    );
  });
});
