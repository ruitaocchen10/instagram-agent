# 0006. Retire legacy persistence after one compatibility release

The current release remains a compatibility release for the previous singleton Instagram connection and `posts` persistence model. It continues to mirror legacy writes into canonical `connections`, `contents`, and `deliveries`, and it preserves the original token, account, and expiry records beside the connection-scoped credential.

The following release may remove that bridge only after a release candidate proves that an upgraded installation preserves all draft, scheduled, failed, and uncertain delivery states, and that reconnecting the migrated account succeeds. This is a forward-only boundary: installations that skip the compatibility release must update through it before installing the retirement release; downgrades from the compatibility release are no longer supported once the bridge is removed.

At retirement, remove the singleton credential/account/expiry helpers, the boot and reconnect mirroring in the shell, the legacy `posts` read/write path and compatibility mirror, the `posts` table after a data-preserving cleanup migration, and the two legacy migration modules. The Instagram Graph API client is not legacy persistence and remains under `lib/platforms/instagram-api.ts`.

## Amendment (2026-07-25): the window closed without a public release

The release-candidate gate above assumed installations in the field. There were none: the application has never been tagged, released, or distributed, and both manifests still read `0.1.0`. The only installation the bridge could protect is the developer's own working database.

So the gate is satisfied by a proportionate check rather than a release candidate: back up `app.db`, open the retirement build once against it, and confirm that drafts, scheduled deliveries, and any failed or uncertain results survive, and that reconnecting the migrated account still works. The forward-only rule is retained for whenever distribution does begin, and it starts from the first released version rather than from the compatibility release described above.

The retirement is complete:

- The singleton credential, account, and expiry helpers are gone, on both the TypeScript and Rust sides.
- The `posts` read/write path, the compatibility mirror, and both legacy migration modules are gone. `contents` and `deliveries` are now the only writers and readers of planned work.
- The Instagram-shaped `Post` survives as a **derived view model** (`lib/content/content-post-view.ts`), reconstructed from content and deliveries for the composer, dashboard, and copilot. It is never persisted. It retires with those surfaces, not with this ADR.
- The `posts` table is dropped by migration 10. No further backfill was run before the drop: migration 9 had already carried every draft and scheduled post across, and the retained `posts` rows were explicitly not needed.

Migration 10 also repairs a defect migration 9 could not express. SQLite's JSON has no boolean type, so `json_object('shareToFeed', 0)` recorded the number `0` where the application writes `false`, and every reader tested that value with `!== false`. A creator who had kept a migrated Reel off the feed would have had it shared anyway. The repair normalizes the stored value, and `deliveryFlag` in `lib/content/social-content.ts` now reads such a flag by what its writer meant rather than trusting one representation. The repair lives in migration 10 rather than as an edit to migration 9 so that installations which already ran migration 9 and fresh installations replaying it converge on identical data.
