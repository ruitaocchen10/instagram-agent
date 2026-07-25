# 0006. Retire legacy persistence after one compatibility release

The current release remains a compatibility release for the previous singleton Instagram connection and `posts` persistence model. It continues to mirror legacy writes into canonical `connections`, `contents`, and `deliveries`, and it preserves the original token, account, and expiry records beside the connection-scoped credential.

The following release may remove that bridge only after a release candidate proves that an upgraded installation preserves all draft, scheduled, failed, and uncertain delivery states, and that reconnecting the migrated account succeeds. This is a forward-only boundary: installations that skip the compatibility release must update through it before installing the retirement release; downgrades from the compatibility release are no longer supported once the bridge is removed.

At retirement, remove the singleton credential/account/expiry helpers, the boot and reconnect mirroring in the shell, the legacy `posts` read/write path and compatibility mirror, the `posts` table after a data-preserving cleanup migration, and the two legacy migration modules. The Instagram Graph API client is not legacy persistence and remains under `lib/platforms/instagram-api.ts`.
