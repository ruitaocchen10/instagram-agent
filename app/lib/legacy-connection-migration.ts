import { LEGACY_INSTAGRAM_CONNECTION_ID } from "./legacy-instagram-migration";
import { instagramAdapter } from "./platforms/instagram-adapter";
import type { StoredConnection } from "./connection-storage";
import type { TokenExpiry } from "./token-state";
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
    ...(expiry
      ? {
          credentialMetadata: {
            expiresAt: expiry.expiresAt,
            expirySource: expiry.source === "meta" ? "platform" : "estimated",
          },
        }
      : {}),
    createdAt: migratedAt,
    updatedAt: migratedAt,
  };
}
