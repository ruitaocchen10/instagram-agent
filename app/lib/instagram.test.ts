import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Stub the Tauri HTTP plugin so no real network (or Tauri host) is touched.
// instagram.ts imports `fetch` from here, so this is the module's I/O seam.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import {
  refreshToken,
  resolveAccount,
  AuthError,
  GraphError,
  DEFAULT_CONFIG,
  fetchMedia,
  publishLocalReel,
} from "./instagram";

const mockFetch = fetch as unknown as Mock;
const mockInvoke = invoke as unknown as Mock;

// Build a minimal Response-like object matching what parse() reads.
function res(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

// A Meta OAuthException (code 190) error payload, optionally with a subcode.
function authErr(message: string, subcode?: number) {
  return {
    error: { type: "OAuthException", message, code: 190, error_subcode: subcode },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockInvoke.mockReset();
});

describe("publishLocalReel", () => {
  it("creates a resumable container, streams the local file, waits, and publishes", async () => {
    const lifecycle: string[] = [];
    mockFetch
      .mockResolvedValueOnce(res({ id: "container-7", uri: "https://rupload.example/session" }))
      .mockResolvedValueOnce(res({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(res({ id: "ig-reel-9" }));
    mockInvoke.mockResolvedValueOnce(undefined);

    await expect(
      publishLocalReel(
        "token",
        "account-7",
        "asset-42.mp4",
        "Launch Reel",
        true,
        DEFAULT_CONFIG,
        {
          onProcessing: () => lifecycle.push("processing"),
          onPublishing: () => lifecycle.push("publishing"),
        },
      ),
    ).resolves.toBe("ig-reel-9");

    const createBody = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(createBody.get("media_type")).toBe("REELS");
    expect(createBody.get("upload_type")).toBe("resumable");
    expect(createBody.get("share_to_feed")).toBe("true");
    expect(createBody.get("video_url")).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("upload_local_reel", {
      assetId: "asset-42.mp4",
      uploadUrl: "https://rupload.example/session",
      accessToken: "token",
    });
    expect(mockFetch.mock.calls[1][0]).toContain("container-7");
    expect(mockFetch.mock.calls[2][0]).toContain("media_publish");
    expect(lifecycle).toEqual(["processing", "publishing"]);
  });
});

describe("fetchMedia", () => {
  it("marks published videos as Reels while retaining their thumbnail", async () => {
    mockFetch.mockResolvedValueOnce(
      res({
        data: [
          {
            id: "reel-1",
            media_type: "VIDEO",
            media_url: "https://cdn.example/reel.mp4",
            thumbnail_url: "https://cdn.example/reel.jpg",
          },
        ],
      }),
    );

    const [post] = await fetchMedia("token", "account", DEFAULT_CONFIG);

    expect(post.imageUrl).toBe("https://cdn.example/reel.jpg");
    expect(post.media).toEqual({
      type: "reel",
      source: { kind: "url", url: "https://cdn.example/reel.mp4" },
      shareToFeed: true,
    });
  });
});

describe("refreshToken", () => {
  it("returns the new token and expires_in on success", async () => {
    mockFetch.mockResolvedValueOnce(
      res({ access_token: "IGAA_NEW", token_type: "bearer", expires_in: 5183944 }),
    );

    const out = await refreshToken("IGAA_OLD", DEFAULT_CONFIG);

    expect(out).toEqual({ token: "IGAA_NEW", expiresIn: 5183944 });
  });

  it("calls the versionless refresh endpoint with the ig_refresh_token grant", async () => {
    mockFetch.mockResolvedValueOnce(res({ access_token: "x", expires_in: 1 }));

    await refreshToken("IGAA_OLD", DEFAULT_CONFIG);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("https://graph.instagram.com/refresh_access_token");
    expect(url).not.toMatch(/\/v\d+\./); // no version segment
    expect(url).toContain("grant_type=ig_refresh_token");
    expect(url).toContain("access_token=IGAA_OLD");
  });

  it("surfaces a code-190 error as an AuthError, not a generic GraphError", async () => {
    mockFetch.mockResolvedValueOnce(res(authErr("Session has expired")));

    const err = await refreshToken("dead", DEFAULT_CONFIG).catch((e) => e);

    expect(err).toBeInstanceOf(AuthError);
  });
});

describe("Graph error detection", () => {
  it("flags code-190 as an AuthError on any call (e.g. resolveAccount)", async () => {
    mockFetch.mockResolvedValueOnce(res(authErr("Error validating access token")));

    const err = await resolveAccount("dead", DEFAULT_CONFIG).catch((e) => e);

    expect(err).toBeInstanceOf(AuthError);
  });

  it("marks a plain expiry (subcode 463) as not revoked", async () => {
    mockFetch.mockResolvedValueOnce(res(authErr("Session has expired", 463)));

    const err = (await resolveAccount("x", DEFAULT_CONFIG).catch((e) => e)) as AuthError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err.revoked).toBe(false);
  });

  it("marks a password-change / de-auth (subcode 460) as revoked", async () => {
    mockFetch.mockResolvedValueOnce(res(authErr("The session has been invalidated", 460)));

    const err = (await resolveAccount("x", DEFAULT_CONFIG).catch((e) => e)) as AuthError;

    expect(err.revoked).toBe(true);
  });

  it("marks an invalid token (subcode 467) as revoked", async () => {
    mockFetch.mockResolvedValueOnce(res(authErr("Invalid access token", 467)));

    const err = (await resolveAccount("x", DEFAULT_CONFIG).catch((e) => e)) as AuthError;

    expect(err.revoked).toBe(true);
  });

  it("keeps a non-190 error as a generic GraphError (not AuthError)", async () => {
    mockFetch.mockResolvedValueOnce(
      res({ error: { type: "GraphMethodException", message: "Unsupported", code: 100 } }),
    );

    const err = await resolveAccount("x", DEFAULT_CONFIG).catch((e) => e);

    expect(err).toBeInstanceOf(GraphError);
    expect(err).not.toBeInstanceOf(AuthError);
  });
});
