import { describe, expect, it, vi } from "vitest";
import {
  publishedReadCapabilities,
  readPublishedContent,
  readPublishedContentThrough,
  reportsPublishedMetric,
} from "./published-content";
import type { PublishedItem, SocialPlatformAdapter } from "./social-content";

const credentials = { accessToken: "token", externalIdentityId: "account-7" };

const item: PublishedItem = { externalId: "ig-42", caption: "The launch starts here." };

// A stand-in adapter keeps these tests about the neutral read: what the app asks
// for, and what it does with a platform that will not answer.
function fakeAdapter(overrides: Partial<SocialPlatformAdapter> = {}): SocialPlatformAdapter {
  return {
    platform: "fake",
    capabilities: { mediaTypes: ["image"], maxCaptionLength: 100 },
    credentialLifetime: { assumedLifetimeMs: 1, refreshFloorMs: 1, refreshWindowMs: 1 },
    credentialRequest: { label: "Token", placeholder: "t…", hint: "Paste a token." },
    establishConnection: vi.fn(),
    refreshCredential: vi.fn(),
    classifyCredentialFailure: () => undefined,
    fetchIdentity: vi.fn(),
    directLocalUpload: [],
    publish: vi.fn(),
    classifyPublishFailure: () => "uncertain",
    publishedRead: { publishedHistory: true, metrics: ["likes"] },
    fetchPublishedContent: vi.fn().mockResolvedValue([item]),
    ...overrides,
  };
}

describe("readPublishedContentThrough", () => {
  it("lists what the platform reports for the connection", async () => {
    const adapter = fakeAdapter();

    await expect(readPublishedContentThrough(adapter, credentials)).resolves.toEqual({
      supported: true,
      items: [item],
    });
    expect(adapter.fetchPublishedContent).toHaveBeenCalledWith(credentials);
  });

  it("reports an unsupported read rather than an empty feed", async () => {
    const adapter = fakeAdapter({ publishedRead: { publishedHistory: false, metrics: [] } });

    // Silence here would be indistinguishable from an account that has published
    // nothing, which is a different answer entirely.
    await expect(readPublishedContentThrough(adapter, credentials)).resolves.toEqual({
      supported: false,
    });
    expect(adapter.fetchPublishedContent).not.toHaveBeenCalled();
  });

  it("reads nothing for a platform with no adapter in this build", async () => {
    await expect(readPublishedContentThrough(undefined, credentials)).resolves.toEqual({
      supported: false,
    });
  });

  it("surfaces a failure from a platform that should have answered", async () => {
    const adapter = fakeAdapter({
      fetchPublishedContent: vi.fn().mockRejectedValue(new Error("feed unavailable")),
    });

    await expect(readPublishedContentThrough(adapter, credentials)).rejects.toThrow(
      "feed unavailable",
    );
  });
});

describe("published read capabilities", () => {
  it("declares what the installed platform reports", () => {
    expect(publishedReadCapabilities("instagram")).toEqual({
      publishedHistory: true,
      metrics: ["likes", "comments"],
    });
    expect(reportsPublishedMetric("instagram", "likes")).toBe(true);
  });

  it("reads back nothing for a platform this build does not support", async () => {
    expect(publishedReadCapabilities("threads")).toEqual({
      publishedHistory: false,
      metrics: [],
    });
    expect(reportsPublishedMetric("threads", "likes")).toBe(false);
    await expect(readPublishedContent("threads", credentials)).resolves.toEqual({
      supported: false,
    });
  });
});
