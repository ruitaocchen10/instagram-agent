import { describe, expect, it } from "vitest";
import { instagramAdapter } from "./platforms/instagram-adapter";
import { LEGACY_INSTAGRAM_CONNECTION_ID } from "./legacy-instagram-migration";
import {
  legacyExpiryForCredential,
  migrateLegacyInstagramConnection,
} from "./legacy-connection-migration";

describe("legacy Instagram connection migration", () => {
  it("preserves the legacy delivery destination while adding a ready connection record", () => {
    expect(migrateLegacyInstagramConnection({
      username: "brand",
      fullName: "Brand Studio",
      followers: 10,
      igUserId: "1784",
    }, { expiresAt: 100, source: "meta" }, 20)).toEqual({
      id: LEGACY_INSTAGRAM_CONNECTION_ID,
      platform: "instagram",
      externalIdentityId: "1784",
      displayName: "@brand",
      health: "ready",
      capabilities: instagramAdapter.capabilities,
      credentialMetadata: { expiresAt: 100, expirySource: "platform" },
      createdAt: 20,
      updatedAt: 20,
    });
  });
});

describe("legacyExpiryForCredential", () => {
  it("mirrors a per-connection lifecycle back into the singleton record", () => {
    expect(legacyExpiryForCredential({ expiresAt: 100, expirySource: "platform" })).toEqual({
      expiresAt: 100,
      source: "meta",
    });
    expect(legacyExpiryForCredential({ expiresAt: 100, expirySource: "estimated" })).toEqual({
      expiresAt: 100,
      source: "estimated",
    });
  });

  it("has nothing to mirror when no expiry was ever recorded", () => {
    expect(legacyExpiryForCredential(undefined)).toBeNull();
    expect(legacyExpiryForCredential({})).toBeNull();
  });
});
