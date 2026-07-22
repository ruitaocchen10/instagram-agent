# Local media publishing

## Scope

Socialite supports single-image posts and Reels from either a remote URL or a
file selected on the user's computer.

## Images

- Remote image URLs keep the existing publishing flow.
- Local images require a user-owned Cloudflare R2 Standard bucket.
- R2 is configured once per installation. V1 supports default and EU
  jurisdictions only.
- Users create a dedicated private bucket, a bucket-scoped Object Read & Write
  token, and a one-day lifecycle rule. The app guides but does not automate
  Cloudflare account administration.
- R2 credentials are entered once in the setup webview and sent directly to a
  native command. The form clears the secret after every attempt; credentials
  are never written to React persistence, SQLite, application logs, or the
  bundle. Long-term storage, signing, verification, and R2 requests happen in
  the Tauri/Rust layer using the OS keychain.
- JPEG, PNG, and WebP inputs are normalized locally to JPEG with metadata
  removed. HEIC and unsupported aspect ratios are rejected without silent
  cropping.
- Draft and scheduled media are copied into app-managed storage. R2 upload is
  just in time. Staged objects are deleted after definitive success, with the
  bucket lifecycle rule as a crash backstop.

## Reels

- Remote Reel URLs remain supported.
- Local Reels upload directly to Meta using its resumable video upload flow;
  they do not use R2.
- V1 accepts MP4 and MOV files and performs a local decode, duration,
  dimensions, and size preflight rather than transcoding. Meta remains the
  final codec/profile validator.
- Users can choose whether a Reel is also shown in Feed. Instagram chooses the
  cover in v1.
- Large files are streamed with progress and cancellation. Immediate publishes
  use a zero-copy hard link when the selected filesystem supports it, with a
  safe managed-copy fallback; saved and scheduled Reels use an independent
  managed local copy.

## Product behavior

- Compose first selects Image or Reel, then Web URL or Local file.
- Without valid R2 configuration, local-image selection is disabled with a
  direct link to the Media staging settings section. URL media and local Reels
  remain available.
- Settings provides guided R2 setup, connection testing, masked status,
  credential replacement, and disconnect. Returning to Compose preserves the
  unfinished post.
- Publish progress reports preparation, upload, Instagram processing,
  publication, and cleanup.
- Pre-Meta failures may retry with backoff. Once Meta accepts a container or
  the result is uncertain, the app does not retry automatically.
- The copilot can publish/schedule existing local-media posts by ID but never
  receives paths or credentials and cannot select a new local file.
- Existing URL-only posts migrate automatically to Image / Web URL.

## Release smoke tests

- [ ] With release credentials, a local Reel completes create-container,
  binary upload, status polling, and publication through the current Instagram
  Login API mode.
- [ ] With release credentials, Instagram accepts an R2 presigned GET URL
  through image-container processing.
- [x] Automated tests cover URL publishing compatibility and legacy post
  migration without user action.
