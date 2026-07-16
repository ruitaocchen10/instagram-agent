# Instagram Agent — Plan

A local-first desktop app to plan, create, and schedule Instagram posts. Chat
with an AI (Claude/OpenAI) to plan content, then a post composer that either
publishes immediately or schedules for later.

## Current status (2026-07-16)

- ✅ **Publishing proven.** Programmatic posting works via the Instagram Content
  Publishing API (`create container → poll status → media_publish`) on
  `graph.instagram.com` (Instagram Login mode, no Facebook Page needed). First
  live post landed on `@findurfootingapp`.
- ✅ **Desktop app scaffolded and running** (`app/`): Tauri v2 + Next.js 16 +
  React 19 + TypeScript, static export. Connect-by-token + publish flow works.
- 🟡 Still a manual-token connect; single-image only; no persistence yet.

## Architecture

### Chosen stack — TypeScript across the stack, packaged with Tauri
- **Desktop shell:** Tauri v2 (Rust, mostly untouched) → installable `.app`/`.exe`/`.deb`.
- **Frontend:** Next.js (static export, `output: 'export'`) + React + TypeScript.
  No SSR/server components/API routes *inside* the bundle — Tauri has no runtime
  Node server. It's effectively "React with great routing."
- **Graph API calls:** `@tauri-apps/plugin-http` (requests go through Rust) to
  bypass webview CORS. Allowed hosts scoped in
  `src-tauri/capabilities/default.json`.
- **Publish logic:** `app/lib/instagram.ts`.

## Storage & scheduling — the key decision

Two things people conflate: **"database" ≠ "backend/server"**, and **"storing a
schedule" ≠ "running a schedule."**

### Storage: local-only is fine (no backend needed)
Tauri gives us local persistence with zero server. **Chosen split (2026-07-16):**
- `tauri-plugin-sql` (**SQLite**, file `app.db`) — app-owned posts: drafts +
  scheduled. Queryable, incremental writes, and a schema that maps cleanly onto
  the future cloud Postgres. This is the source of truth for local posts.
- `@tauri-apps/plugin-store` — small singletons only (settings, connected
  account) in a plaintext JSON file (`app.json`).
- OS keychain (`keyring`) — secrets like the IG access token (never in SQLite or
  plain JSON).

Published posts are **not** stored locally — they're Instagram-owned and fetched
from the Graph API. So drafts/scheduled/settings/account live locally; published
media + engagement are remote. **The local SQLite DB needs no backend.**

### Scheduling: this is what may force a backend
Storing a schedule locally is trivial. **Executing** it is the hard part —
something must be running at the scheduled moment to fire the post.

| Approach | Storage | Fires when computer is off? | Tokens server-side? |
|---|---|---|---|
| Local-only (SQLite/files) | Local | ❌ No | ✅ No (privacy win) |
| Menu-bar agent (app always running) | Local | ⚠️ Only if machine awake | ✅ No |
| Cloud backend + DB + worker | Server | ✅ Yes (reliable) | ⚠️ Yes (bigger trust/security surface) |

Second forcing function: **Instagram fetches post media from a public URL**, so a
scheduled post also needs its image publicly hosted *at fire time* — a sleeping
laptop can't serve that either.

**Decision:**
- **MVP / validation:** local-first (SQLite or store plugin). "Post now" and
  "schedule while the app is running" need no backend. Keeps tokens on-device.
- **Real scheduling product:** needs a **cloud backend + DB (e.g. Postgres via
  Supabase/Neon) + a worker/cron** so posts fire even when the machine is off.
  This is also where public media hosting lives (S3/R2). Likely a hosted Next.js
  app — which could double as a future web version.

Rule of thumb: **build the backend only when "schedule a post and trust it fires
even if my laptop is closed" becomes a real requirement.** Until then, local
storage keeps us moving.

## Roadmap

1. **Local persistence** — ✅ posts (drafts + scheduled) in SQLite
   (`tauri-plugin-sql`), token in OS keychain, account/settings in store plugin.
   Dashboard/calendar/library now read persisted local data; published + follower
   count still mock pending the remote-data pass.
2. **Real OAuth "Connect Instagram"** — replace manual token paste.
3. **Post composer + "post now"** — polish the create flow.
4. **Local scheduling** — schedule while app/menu-bar agent is running.
5. **AI chat-to-plan** — Claude/OpenAI layer to plan content and fill the composer.
6. **Cloud backend** (when reliable scheduling is needed) — DB, worker, media hosting.
7. **Carousels / Reels / Stories.**
8. **Distribution** — code signing + notarization, auto-update, landing-page download + CLI install.

## Known constraints / gotchas

- **Instagram Business/Creator accounts only** (not Personal).
- **Media must be a public URL** — no local file upload to the API directly.
- **App Review** required to publish to *other users'* accounts; dev mode only
  allows Instagram Tester accounts.
- **"Insufficient Developer Role"** = the IG account isn't added as an Instagram
  Tester (separate from app Admin role) or hasn't accepted the invite. See
  `SETUP.md`.
- **Code signing/notarization** needed to distribute without OS warnings.
