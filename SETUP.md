# Instagram Publishing — Setup & Gotchas

How to get programmatic Instagram publishing working from scratch. Captures the
Meta dashboard steps and the traps that cost us time. Verified working on
2026-07-16 (published to `@findurfootingapp` via `graph.instagram.com`).

## Overview

Publishing uses the **Instagram Content Publishing API**. The flow is always:

1. Create a media *container* → `POST /{ig-user-id}/media` with a public `image_url` + `caption`
2. Poll the container until `status_code == FINISHED`
3. Publish it → `POST /{ig-user-id}/media_publish` with the `creation_id`

Key constraint: **Instagram fetches the image from a public URL** — you cannot
upload a local file. Media must be hosted somewhere publicly reachable.

## Two API setups (pick one in the Meta dashboard)

| | Instagram Login (what we use) | Facebook Login (old "Instagram Graph API") |
|---|---|---|
| Base host | `graph.instagram.com` | `graph.facebook.com` |
| Facebook Page required? | **No** | Yes |
| Auth | Instagram's own OAuth | Facebook Login OAuth |
| Our `API_MODE` | `instagram` | `facebook` |

We use **Instagram Login** — simpler, no Facebook Page needed.

## One-time Meta setup

1. **developers.facebook.com** → create an app (type **Business**).
2. Account must be **Instagram Business or Creator** (not Personal). Convert in
   the Instagram app settings — free and reversible.
3. App dashboard → **Add Product** → **Instagram** → **Set up**.
4. Choose **"Instagram API setup with Instagram login."**
5. Note your **Instagram app ID / secret** and add **OAuth redirect URIs**
   (localhost is fine for dev).
6. Required scopes: `instagram_business_basic`, `instagram_business_content_publish`.

## ⚠️ The gotcha that cost us time: "Insufficient Developer Role"

While the app is in **Development mode**, the API only works for Instagram
accounts explicitly added as **Instagram Testers**. There are **two separate
role systems** — being an app **Admin** (a Facebook user) does **not**
authorize your Instagram account.

Fix (both steps required):

1. App dashboard → **Roles** → **Instagram Testers** section → add your IG
   **username** (not display name). Status shows *Pending*.
2. **Accept the invite from inside Instagram**: Settings → Apps and websites →
   **Tester invites** → Accept. Status flips to *Accepted*.

Then generate the token — the role error disappears.

## Generating a token for the test

Use the **Graph API Explorer** or the token generator on the Instagram setup
page. Needs the `instagram_business_content_publish` scope. Paste it into the
test app's Connect box (or set `ACCESS_TOKEN` in `.env`).

## Running the app (desktop)

The product is the Tauri + Next.js desktop app in `desktop/`:

```bash
cd desktop
npm install
npm run tauri dev        # opens the native app window
```

Paste your access token in the Connect box, pick the API mode, and publish.
Requires the Rust toolchain (`rustup`) for the Tauri shell.

## Archived Python prototype

The original proof-of-concept lives in `prototype-python/` (kept for reference
only — its publish logic is ported to `desktop/lib/instagram.ts`):

```bash
cd prototype-python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # optional: prefill ACCESS_TOKEN / API_MODE
python app.py             # → http://localhost:5001
```

Note: port **5001**, not 5000 — macOS AirPlay Receiver squats on 5000 and
returns 403. Config knobs (in `.env`): `API_MODE` (`instagram`/`facebook`),
`GRAPH_VERSION`, `ACCESS_TOKEN`, `IG_USER_ID`, `PORT`.

## Still not done (known gaps)

- **App Review** — required before publishing to *other users'* accounts. In
  dev mode you can only publish to Instagram Tester accounts.
- **Public media hosting** — real user images need cloud hosting (S3/R2); the
  test relied on an already-public URL (picsum.photos).
- **Real OAuth** — the test uses a manually pasted token, not the proper
  "Connect Instagram" login flow.
