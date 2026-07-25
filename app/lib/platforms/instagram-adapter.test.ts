import { describe, expect, it, vi } from "vitest";
import { AuthError, DEFAULT_CONFIG, GraphError } from "../instagram";
import type { PublicationRequest } from "../social-content";
import { createInstagramAdapter, instagramAdapter } from "./instagram-adapter";

const credentials = { accessToken: "token", externalIdentityId: "account-7" };
const lifecycle = { onProcessing: () => {}, onPublishing: () => {} };

function request(overrides: Partial<PublicationRequest> = {}): PublicationRequest {
  return {
    media: { type: "image", kind: "public-url", url: "https://cdn.example.com/launch.jpg" },
    caption: "The launch starts here.",
    credentials,
    lifecycle,
    ...overrides,
  };
}

describe("instagramAdapter", () => {
  it("declares the capabilities the composer and publisher validate against", () => {
    expect(instagramAdapter).toMatchObject({
      platform: "instagram",
      capabilities: { mediaTypes: ["image", "video"], maxCaptionLength: 2200 },
      directLocalUpload: ["video"],
    });
  });

  it("publishes an image the platform fetches from a public URL", async () => {
    const publishImage = vi.fn().mockResolvedValue("ig-42");
    const adapter = createInstagramAdapter({ publishImage });

    await expect(adapter.publish(request())).resolves.toEqual({ externalId: "ig-42" });
    expect(publishImage).toHaveBeenCalledWith(
      "token",
      "account-7",
      "https://cdn.example.com/launch.jpg",
      "The launch starts here.",
      DEFAULT_CONFIG,
      lifecycle,
    );
  });

  it("uploads a local video through the resumable Reel upload", async () => {
    const publishLocalReel = vi.fn().mockResolvedValue("ig-reel-9");
    const adapter = createInstagramAdapter({ publishLocalReel });

    await expect(
      adapter.publish(
        request({
          media: { type: "video", kind: "local-asset", assetId: "asset-2.mp4" },
          platformOptions: { shareToFeed: false },
        }),
      ),
    ).resolves.toEqual({ externalId: "ig-reel-9" });
    expect(publishLocalReel).toHaveBeenCalledWith(
      "token",
      "account-7",
      "asset-2.mp4",
      "The launch starts here.",
      false,
      DEFAULT_CONFIG,
      lifecycle,
    );
  });

  it("shares a Reel to the feed unless the delivery opted out", async () => {
    const publishReelFromUrl = vi.fn().mockResolvedValue("ig-reel-10");
    const adapter = createInstagramAdapter({ publishReelFromUrl });

    await adapter.publish(
      request({ media: { type: "video", kind: "public-url", url: "https://cdn.example.com/r.mp4" } }),
    );

    expect(publishReelFromUrl).toHaveBeenCalledWith(
      "token",
      "account-7",
      "https://cdn.example.com/r.mp4",
      "The launch starts here.",
      true,
      DEFAULT_CONFIG,
      lifecycle,
    );
  });

  it("refuses an image that was never staged, because Instagram must fetch it", async () => {
    const publishImage = vi.fn();
    const adapter = createInstagramAdapter({ publishImage });

    await expect(
      adapter.publish(request({ media: { type: "image", kind: "local-asset", assetId: "a.jpg" } })),
    ).rejects.toThrow("needs staging");
    expect(publishImage).not.toHaveBeenCalled();
  });

  it.each([
    ["a canceled upload", new Error("Reel upload canceled."), "canceled"],
    ["a rejected credential", new AuthError("Token expired"), "authentication"],
    ["an interrupted call", new GraphError("response lost"), "uncertain"],
  ])("classifies %s", (_label, error, expected) => {
    expect(createInstagramAdapter().classifyPublishFailure(error)).toBe(expected);
  });

  it("reads the account's published media through the configured API version", async () => {
    const published = [{ id: "ig-42", imageUrl: "", caption: "", status: "published" as const }];
    const fetchMedia = vi.fn().mockResolvedValue(published);
    const adapter = createInstagramAdapter({ fetchMedia }, { mode: "facebook", version: "v20.0" });

    await expect(adapter.fetchPublishedPosts(credentials)).resolves.toBe(published);
    expect(fetchMedia).toHaveBeenCalledWith("token", "account-7", {
      mode: "facebook",
      version: "v20.0",
    });
  });
});
