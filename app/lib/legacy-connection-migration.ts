import { LEGACY_INSTAGRAM_CONNECTION_ID } from "./legacy-instagram-migration";
import { instagramAdapter } from "./platforms/instagram-adapter";
import type { StoredConnection } from "./connection-storage";
import type { TokenExpiry } from "./storage";
import type { ConnectionCredentialMetadata } from "./social-content";
import type { Account } from "./types";

// Existing deliveries already point to this stable ID. Migrating the
// singleton account must retain it so drafts and scheduled deliveries keep
// their destination without a destructive rewrite.
export function migrateLegacyInstagramConnection(
  account: Account,
  expiry: TokenExpiry | null,
  migratedAt: number,
): StoredConnection {
  return {
    id: LEGACY_INSTAGRAM_CONNECTION_ID,
    platform: instagramAdapter.platform,
    externalIdentityId: account.igUserId,
    displayName: `@${account.username}`,
    health: "ready",
    capabilities: instagramAdapter.capabilities,
    ...(expiry ? { credentialMetadata: credentialMetadataForExpiry(expiry) } : {}),
    createdAt: migratedAt,
    updatedAt: migratedAt,
  };
}

export function credentialMetadataForExpiry(expiry: TokenExpiry): ConnectionCredentialMetadata {
  return {
    expiresAt: expiry.expiresAt,
    expirySource: expiry.source === "meta" ? "platform" : "estimated",
  };
}

// The reverse conversion, for as long as the migrated installation keeps its
// singleton expiry record readable beside the per-connection lifecycle. A
// connection whose platform never reported an expiry has nothing to mirror.
export function legacyExpiryForCredential(
  metadata: ConnectionCredentialMetadata | undefined,
): TokenExpiry | null {
  if (metadata?.expiresAt == null) return null;
  return {
    expiresAt: metadata.expiresAt,
    source: metadata.expirySource === "platform" ? "meta" : "estimated",
  };
}
