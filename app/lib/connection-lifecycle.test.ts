import { describe, expect, it, vi } from "vitest";
import {
  connectDestination,
  credentialFailureFor,
  ensureUsableCredential,
} from "./connection-lifecycle";
import type { StoredConnection } from "./connection-storage";
import { AuthError } from "./instagram";
import type {
  ConnectionIdentity,
  PlatformCredential,
  SocialPlatformAdapter,
} from "./social-content";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 5, 1);

const identity: ConnectionIdentity = {
  externalIdentityId: "17841435046597",
  handle: "findurfootingapp",
  displayName: "@findurfootingapp",
  fullName: "Find Ur Footing",
  audienceCount: 1280,
};

// A stand-in adapter keeps these tests about the neutral lifecycle: which ID a
// destination gets, what the stored connection records, and how a platform's
// refusal to refresh is read. Instagram's own exchange is covered in
// platforms/instagram-adapter.test.ts.
function fakeAdapter(overrides: Partial<SocialPlatformAdapter> = {}): SocialPlatformAdapter {
  return {
    platform: "instagram",
    capabilities: { mediaTypes: ["image", "video"], maxCaptionLength: 2200 },
    credentialLifetime: {
      assumedLifetimeMs: 60 * DAY,
      refreshFloorMs: 24 * HOUR,
      refreshWindowMs: 10 * DAY,
    },
    credentialRequest: { label: "Access token", placeholder: "IGAA…", hint: "Paste a token." },
    establishConnection: vi.fn().mockResolvedValue({
      identity,
      credential: {
        secret: "long-lived-token",
        metadata: { expiresAt: NOW + 60 * DAY, expirySource: "platform", lastRefreshedAt: NOW },
      },
    }),
    refreshCredential: vi.fn(),
    classifyCredentialFailure: () => undefined,
    fetchIdentity: vi.fn(),
    directLocalUpload: ["video"],
    publish: vi.fn(),
    classifyPublishFailure: () => "uncertain",
    publishedRead: { publishedHistory: true, metrics: ["likes", "comments"] },
    fetchPublishedContent: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function dependencies(adapter: SocialPlatformAdapter) {
  return {
    resolveAdapter: () => adapter,
    saveConnection: vi.fn().mockResolvedValue(undefined),
    saveCredential: vi.fn().mockResolvedValue(undefined),
  };
}

const existing: StoredConnection = {
  id: "legacy-instagram-default",
  platform: "instagram",
  externalIdentityId: identity.externalIdentityId,
  displayName: "@findurfootingapp",
  health: "disconnected",
  credentialMetadata: { expiresAt: NOW - DAY, expirySource: "estimated" },
  createdAt: NOW - 90 * DAY,
  updatedAt: NOW - DAY,
};

describe("connectDestination", () => {
  it("records a new destination under an ID derived from the account", async () => {
    const adapter = fakeAdapter();
    const deps = dependencies(adapter);

    const connected = await connectDestination(
      { platform: "instagram", secret: "  pasted-token  ", now: NOW },
      deps,
    );

    expect(adapter.establishConnection).toHaveBeenCalledWith("pasted-token", NOW);
    expect(connected.connection).toEqual({
      id: "instagram-17841435046597",
      platform: "instagram",
      externalIdentityId: identity.externalIdentityId,
      displayName: "@findurfootingapp",
      health: "ready",
      capabilities: adapter.capabilities,
      credentialMetadata: {
        expiresAt: NOW + 60 * DAY,
        expirySource: "platform",
        lastRefreshedAt: NOW,
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(connected.secret).toBe("long-lived-token");
    expect(connected.identity).toEqual(identity);
  });

  it("stores the credential before the connection it belongs to", async () => {
    const order: string[] = [];
    const adapter = fakeAdapter();
    const deps = {
      resolveAdapter: () => adapter,
      saveCredential: vi.fn(async () => {
        order.push("credential");
      }),
      saveConnection: vi.fn(async () => {
        order.push("connection");
      }),
    };

    await connectDestination({ platform: "instagram", secret: "pasted-token", now: NOW }, deps);

    expect(order).toEqual(["credential", "connection"]);
    expect(deps.saveCredential).toHaveBeenCalledWith("instagram-17841435046597", "long-lived-token");
  });

  it("reconnects an existing destination in place, keeping its ID and creation time", async () => {
    const adapter = fakeAdapter();
    const deps = dependencies(adapter);

    const connected = await connectDestination(
      { platform: "instagram", secret: "fresh-token", existing, now: NOW },
      deps,
    );

    expect(connected.connection).toMatchObject({
      id: existing.id,
      health: "ready",
      createdAt: existing.createdAt,
      updatedAt: NOW,
    });
  });

  it("refuses a credential for a different account than the connection publishes to", async () => {
    const adapter = fakeAdapter({
      establishConnection: vi.fn().mockResolvedValue({
        identity: { ...identity, externalIdentityId: "999", displayName: "@someone-else" },
        credential: { secret: "other-token", metadata: {} } satisfies PlatformCredential,
      }),
    });
    const deps = dependencies(adapter);

    await expect(
      connectDestination({ platform: "instagram", secret: "other-token", existing, now: NOW }, deps),
    ).rejects.toThrow(
      "This credential is for @someone-else, but this connection publishes to @findurfootingapp",
    );
    expect(deps.saveCredential).not.toHaveBeenCalled();
    expect(deps.saveConnection).not.toHaveBeenCalled();
  });

  it("rejects an empty credential without calling the platform", async () => {
    const adapter = fakeAdapter();
    const deps = dependencies(adapter);

    await expect(
      connectDestination({ platform: "instagram", secret: "   ", now: NOW }, deps),
    ).rejects.toThrow("Enter the credential for this destination.");
    expect(adapter.establishConnection).not.toHaveBeenCalled();
  });

  it("folds an account ID with unusable characters into a storable connection ID", async () => {
    const adapter = fakeAdapter({
      establishConnection: vi.fn().mockResolvedValue({
        identity: { ...identity, externalIdentityId: "acct:12/34" },
        credential: { secret: "token", metadata: {} } satisfies PlatformCredential,
      }),
    });

    const connected = await connectDestination(
      { platform: "instagram", secret: "token", now: NOW },
      dependencies(adapter),
    );

    expect(connected.connection.id).toBe("instagram-acct_12_34");
    // The platform's own ID is kept intact for its API calls.
    expect(connected.connection.externalIdentityId).toBe("acct:12/34");
  });
});

describe("ensureUsableCredential", () => {
  const ready: StoredConnection = {
    ...existing,
    health: "ready",
    credentialMetadata: { expiresAt: NOW + 60 * DAY, expirySource: "platform" },
  };

  it("keeps a healthy credential without contacting the platform", async () => {
    const adapter = fakeAdapter();
    const deps = dependencies(adapter);

    await expect(ensureUsableCredential(ready, "token", NOW, deps)).resolves.toEqual({
      state: "usable",
      secret: "token",
    });
    expect(adapter.refreshCredential).not.toHaveBeenCalled();
  });

  it("reports a lapsed credential as unusable without an outward call", async () => {
    const adapter = fakeAdapter();
    const deps = dependencies(adapter);
    const lapsed = {
      ...ready,
      credentialMetadata: { expiresAt: NOW - 1, expirySource: "platform" as const },
    };

    await expect(ensureUsableCredential(lapsed, "token", NOW, deps)).resolves.toEqual({
      state: "unusable",
      failure: "expired",
    });
    expect(adapter.refreshCredential).not.toHaveBeenCalled();
  });

  it("rolls an eligible credential forward and records the new lifecycle", async () => {
    const credential: PlatformCredential = {
      secret: "rolled-token",
      metadata: { expiresAt: NOW + 60 * DAY, expirySource: "platform", lastRefreshedAt: NOW },
    };
    const adapter = fakeAdapter({ refreshCredential: vi.fn().mockResolvedValue(credential) });
    const deps = dependencies(adapter);
    const aging = {
      ...ready,
      credentialMetadata: { expiresAt: NOW + 5 * DAY, expirySource: "platform" as const },
    };

    const check = await ensureUsableCredential(aging, "token", NOW, deps);

    expect(adapter.refreshCredential).toHaveBeenCalledWith("token", NOW);
    expect(check).toEqual({
      state: "refreshed",
      secret: "rolled-token",
      connection: { ...aging, credentialMetadata: credential.metadata, updatedAt: NOW },
    });
    expect(deps.saveCredential).toHaveBeenCalledWith(aging.id, "rolled-token");
    expect(deps.saveConnection).toHaveBeenCalledWith({
      ...aging,
      credentialMetadata: credential.metadata,
      updatedAt: NOW,
    });
  });

  it("restores health when a connection needing attention refreshes successfully", async () => {
    const adapter = fakeAdapter({
      refreshCredential: vi.fn().mockResolvedValue({
        secret: "rolled-token",
        metadata: { expiresAt: NOW + 60 * DAY, expirySource: "platform" },
      }),
    });
    const attention = {
      ...ready,
      health: "attention" as const,
      credentialMetadata: { expiresAt: NOW + 5 * DAY, expirySource: "platform" as const },
    };

    const check = await ensureUsableCredential(attention, "token", NOW, dependencies(adapter));

    expect(check).toMatchObject({ state: "refreshed", connection: { health: "ready" } });
  });

  it("keeps using the current credential when the platform declines the refresh", async () => {
    // Not eligible yet, or a transient network failure: neither says anything
    // about whether the credential still works.
    const adapter = fakeAdapter({
      refreshCredential: vi.fn().mockRejectedValue(new Error("network unreachable")),
    });
    const deps = dependencies(adapter);
    const aging = {
      ...ready,
      credentialMetadata: { expiresAt: NOW + 5 * DAY, expirySource: "platform" as const },
    };

    await expect(ensureUsableCredential(aging, "token", NOW, deps)).resolves.toEqual({
      state: "usable",
      secret: "token",
    });
    expect(deps.saveConnection).not.toHaveBeenCalled();
  });

  it("reports the platform's authentication verdict when a refresh is rejected", async () => {
    const adapter = fakeAdapter({
      refreshCredential: vi.fn().mockRejectedValue(new AuthError("code 190", true)),
      classifyCredentialFailure: (error) =>
        error instanceof AuthError ? (error.revoked ? "revoked" : "expired") : undefined,
    });
    const deps = dependencies(adapter);
    const aging = {
      ...ready,
      credentialMetadata: { expiresAt: NOW + 5 * DAY, expirySource: "platform" as const },
    };

    await expect(ensureUsableCredential(aging, "token", NOW, deps)).resolves.toEqual({
      state: "unusable",
      failure: "revoked",
    });
    expect(deps.saveCredential).not.toHaveBeenCalled();
  });
});

describe("credentialFailureFor", () => {
  it("reads a platform's own authentication failure through its adapter", () => {
    expect(credentialFailureFor("instagram", new AuthError("code 190"))).toBe("expired");
    expect(credentialFailureFor("instagram", new AuthError("code 190", true))).toBe("revoked");
  });

  it("has no verdict on a failure that is not about the credential", () => {
    expect(credentialFailureFor("instagram", new Error("HTTP 500"))).toBeUndefined();
  });

  it("has no verdict for a platform this build has no adapter for", () => {
    expect(credentialFailureFor("threads", new AuthError("code 190"))).toBeUndefined();
  });
});
