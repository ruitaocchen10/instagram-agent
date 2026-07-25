import { describe, expect, it, vi } from "vitest";
import { AuthError, DEFAULT_CONFIG, GraphError } from "../legacy/instagram";
import type { ConnectionIdentity, PublicationRequest } from "../content/social-content";
import type { Account } from "../shared/types";
import { createInstagramAdapter, instagramAdapter } from "./instagram-adapter";

const credentials = { accessToken: "token", externalIdentityId: "account-7" };
const lifecycle = { onProcessing: () => {}, onPublishing: () => {} };

const account: Account = {
  igUserId: "account-7",
  username: "findurfootingapp",
  fullName: "Find Ur Footing",
  followers: 1280,
  profilePicUrl: "https://cdn.example.com/avatar.jpg",
};

const identity: ConnectionIdentity = {
  externalIdentityId: "account-7",
  handle: "findurfootingapp",
  displayName: "@findurfootingapp",
  fullName: "Find Ur Footing",
  audienceCount: 1280,
  avatarUrl: "https://cdn.example.com/avatar.jpg",
};

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
    const fetchMedia = vi.fn().mockResolvedValue([]);
    const adapter = createInstagramAdapter({ fetchMedia }, { mode: "facebook", version: "v20.0" });

    await expect(adapter.fetchPublishedContent?.(credentials)).resolves.toEqual([]);
    expect(fetchMedia).toHaveBeenCalledWith("token", "account-7", {
      mode: "facebook",
      version: "v20.0",
    });
  });

  it("reports published media in neutral terms, with the platform's own figures", async () => {
    const fetchMedia = vi.fn().mockResolvedValue([
      {
        id: "ig-42",
        mediaType: "VIDEO",
        mediaUrl: "https://cdn.example/reel.mp4",
        thumbnailUrl: "https://cdn.example/reel.jpg",
        caption: "The launch starts here.",
        permalink: "https://instagram.example/p/42",
        timestamp: "2026-06-01T00:00:00+0000",
        likeCount: 612,
        commentsCount: 34,
      },
    ]);

    await expect(
      createInstagramAdapter({ fetchMedia }).fetchPublishedContent?.(credentials),
    ).resolves.toEqual([
      {
        externalId: "ig-42",
        caption: "The launch starts here.",
        // A Reel is a video to every other platform; only Instagram calls it a Reel.
        media: { type: "video", source: { kind: "url", url: "https://cdn.example/reel.mp4" } },
        previewUrl: "https://cdn.example/reel.jpg",
        permalink: "https://instagram.example/p/42",
        publishedAt: Date.UTC(2026, 5, 1),
        metrics: { likes: 612, comments: 34 },
      },
    ]);
  });

  it("leaves an engagement figure absent when Instagram omits it", async () => {
    const fetchMedia = vi
      .fn()
      .mockResolvedValue([{ id: "ig-43", mediaUrl: "https://cdn.example/still.jpg" }]);

    const [item] = (await createInstagramAdapter({ fetchMedia }).fetchPublishedContent?.(
      credentials,
    )) ?? [];

    // An unreported count must not read as zero engagement.
    expect(item.metrics).toEqual({});
    expect(item.caption).toBe("");
  });
});

describe("instagramAdapter connections", () => {
  const NOW = Date.UTC(2026, 5, 1);
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

  it("declares the credential it asks for and the lifetime Meta grants it", () => {
    expect(instagramAdapter.credentialRequest.label).toBe("Instagram access token");
    expect(instagramAdapter.credentialLifetime).toEqual({
      assumedLifetimeMs: SIXTY_DAYS,
      refreshFloorMs: 24 * 60 * 60 * 1000,
      refreshWindowMs: 10 * 24 * 60 * 60 * 1000,
    });
  });

  it("exchanges a refresh-eligible token for one with Meta's own expiry", async () => {
    const resolveAccount = vi.fn().mockResolvedValue(account);
    const refreshToken = vi.fn().mockResolvedValue({ token: "rolled", expiresIn: 5_184_000 });
    const adapter = createInstagramAdapter({ resolveAccount, refreshToken });

    await expect(adapter.establishConnection("pasted", NOW)).resolves.toEqual({
      identity,
      credential: {
        secret: "rolled",
        metadata: {
          expiresAt: NOW + 5_184_000_000,
          expirySource: "platform",
          lastRefreshedAt: NOW,
        },
      },
    });
    expect(resolveAccount).toHaveBeenCalledWith("pasted", DEFAULT_CONFIG);
  });

  it("keeps a freshly issued token on an estimated lifetime when Meta declines the refresh", async () => {
    // Meta refuses to refresh a token less than 24 hours old, which is the
    // normal case for a token pasted straight from its dashboard.
    const adapter = createInstagramAdapter({
      resolveAccount: vi.fn().mockResolvedValue(account),
      refreshToken: vi.fn().mockRejectedValue(new GraphError("not eligible yet")),
    });

    await expect(adapter.establishConnection("pasted", NOW)).resolves.toEqual({
      identity,
      credential: {
        secret: "pasted",
        metadata: { expiresAt: NOW + SIXTY_DAYS, expirySource: "estimated" },
      },
    });
  });

  it("refuses a credential the account lookup rejects", async () => {
    const adapter = createInstagramAdapter({
      resolveAccount: vi.fn().mockRejectedValue(new AuthError("Token expired")),
      refreshToken: vi.fn(),
    });

    await expect(adapter.establishConnection("stale", NOW)).rejects.toThrow("Token expired");
  });

  it("rolls a credential forward on its own, without a fallback estimate", async () => {
    const refreshToken = vi.fn().mockResolvedValue({ token: "rolled", expiresIn: 60 });
    const adapter = createInstagramAdapter({ refreshToken });

    await expect(adapter.refreshCredential("current", NOW)).resolves.toEqual({
      secret: "rolled",
      metadata: { expiresAt: NOW + 60_000, expirySource: "platform", lastRefreshedAt: NOW },
    });
  });

  it("propagates the platform's refusal to refresh so the lifecycle can classify it", async () => {
    const adapter = createInstagramAdapter({
      refreshToken: vi.fn().mockRejectedValue(new AuthError("Token expired")),
    });

    await expect(adapter.refreshCredential("current", NOW)).rejects.toThrow(AuthError);
  });

  it.each([
    ["a lapsed token", new AuthError("Token expired"), "expired"],
    ["a revoked token", new AuthError("Session invalidated", true), "revoked"],
    ["an unrelated failure", new GraphError("HTTP 500"), undefined],
  ])("reads %s as a credential verdict", (_label, error, expected) => {
    expect(instagramAdapter.classifyCredentialFailure(error)).toBe(expected);
  });

  it("reports the account behind a live credential as a neutral identity", async () => {
    const resolveAccount = vi.fn().mockResolvedValue(account);
    const adapter = createInstagramAdapter({ resolveAccount });

    await expect(adapter.fetchIdentity(credentials)).resolves.toEqual(identity);
    expect(resolveAccount).toHaveBeenCalledWith("token", DEFAULT_CONFIG);
  });

  it("omits profile details Instagram did not return", async () => {
    const adapter = createInstagramAdapter({
      resolveAccount: vi
        .fn()
        .mockResolvedValue({ igUserId: "account-7", username: "solo", fullName: "", followers: 0 }),
    });

    await expect(adapter.fetchIdentity(credentials)).resolves.toEqual({
      externalIdentityId: "account-7",
      handle: "solo",
      displayName: "@solo",
      audienceCount: 0,
    });
  });
});
