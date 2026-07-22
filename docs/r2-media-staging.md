# Cloudflare R2 media staging for Instagram

> Historical design research. The selected v1 design is user-owned R2 with
> native signing and no Worker; see `local-media-publishing-spec.md`.

Research date: 2026-07-22. Sources are Cloudflare and Meta documentation.

## Recommendation

Keep the R2 bucket private. Put a small authenticated Cloudflare Worker in front
of it that issues short-lived, object-specific presigned URLs:

1. The desktop app asks the Worker to begin an upload, sending declared media
   type and size.
2. The Worker authenticates the app user, enforces quotas/type/size, chooses a
   random object key, and returns a short-lived presigned `PUT` URL.
3. The desktop app uploads the file directly to R2, so the media bytes do not
   pass through the Worker.
4. The app completes the upload with the Worker. The Worker checks the stored
   object's actual metadata and returns a short-lived presigned `GET` URL.
5. The app passes that HTTPS `GET` URL to Instagram, polls the media container,
   publishes, then asks the Worker to delete the staged object. A bucket
   lifecycle rule is the cleanup backstop.

This fits both platforms' documented models. Meta says it cURLs the supplied
`image_url`/`video_url`, which therefore must be on a public server. R2 presigned
URLs grant anyone holding the URL temporary access to one operation on one
object, without disclosing the R2 credential. The R2 URL should therefore be
reachable by Meta while remaining inaccessible without its signature.
([Meta: create an image container](https://www.postman.com/meta/instagram/request/23987686-f4b5a72d-a125-4080-8968-93de1a549e68),
[Cloudflare: presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/))

This compatibility is a reasoned integration choice, not something Meta's docs
specifically certify for R2. Test a signed R2 `GET` through the complete
container/publish flow before shipping it.

## Setup required from the app owner

1. Create a Cloudflare account and activate the R2 subscription through its
   checkout flow. R2 requires a subscription even though it includes free
   monthly usage. Create a Standard-class bucket such as
   `socialite-media-staging`; buckets start private.
   ([R2 get started](https://developers.cloudflare.com/r2/get-started/),
   [create buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/))
2. Deploy an upload-broker Worker and bind it to the bucket for metadata checks
   and deletion. If it generates S3 presigned URLs, create an **Object Read &
   Write** R2 API token scoped only to this bucket. Store its access-key ID and
   secret-access key as encrypted Worker secrets, never in the Tauri bundle or
   source control. Cloudflare's account R2 tokens remain valid until revoked,
   and the secret is displayed only once.
   ([R2 authentication and token scopes](https://developers.cloudflare.com/r2/api/tokens/),
   [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/))
3. Give the Worker an authentication mechanism for *your app's users*. A
   desktop binary cannot safely contain a shared permanent API secret. In a
   product release, the Worker should validate an app session/JWT or similarly
   revocable per-user credential before it signs anything. It should also apply
   per-user quotas/rate limits. Cloudflare's reference architecture explicitly
   places authentication, permission, MIME, and size validation before issuing
   a direct-upload signed URL.
   ([storing user-generated content](https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/),
   [Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/))
4. Add a lifecycle expiration rule on the staging prefix. Delete immediately
   after Instagram has ingested/published the media, but use a short fallback
   retention window for abandoned uploads. R2 says expired objects are typically
   removed within 24 hours of their expiration value, so lifecycle expiry is not
   an exact-time deletion mechanism.
   ([R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/))
5. Configure CORS only if the upload is made through browser/webview `fetch`.
   Allow the app's exact origin, `PUT` (and only other methods actually used),
   and required headers such as `Content-Type`. Without bucket CORS,
   browser-based presigned uploads fail. A native Tauri HTTP request is not
   subject to browser CORS, and CORS is not a substitute for authenticating the
   signing endpoint.
   ([R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/))

A custom domain is not required for this design. R2 presigned URLs only work on
the S3 API hostname (`<ACCOUNT_ID>.r2.cloudflarestorage.com`) and last from one
second to seven days. They cannot use a custom domain. They are bearer tokens:
anyone who gets the exact URL can use it until expiry.
([R2 presigned URL constraints](https://developers.cloudflare.com/r2/api/s3/presigned-urls/))

## Why not make the whole bucket public?

R2 buckets are private by default. Public access can use a custom domain or an
`r2.dev` development URL, but Cloudflare rate-limits `r2.dev` and says it is not
for production. A custom domain is the production option when a bucket must be
public and enables caching/WAF features. Staging does not need blanket public
read access: a private bucket plus one signed `GET` exposes less data.
([R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/))

## Cost and capacity

As of the research date, Standard R2 includes 10 GB-month storage, one million
Class A operations (writes/listing), ten million Class B operations (reads), and
free Internet egress each month. Above that, Standard storage is $0.015 per
GB-month, Class A is $4.50 per million, and Class B is $0.36 per million. Deletes
are free. Standard is a better fit than Infrequent Access for short-lived
staging because it has no retrieval fee or 30-day minimum storage duration.
([R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[R2 storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/))

For scale intuition, 1,000 files of 10 MB retained for two days represent about
0.67 GB-month, 1,000 writes, and roughly 1,000 Instagram reads: all within the
current R2 free allowances. Traffic patterns, retries, previews, and larger
video files raise those numbers. The app owner pays the Cloudflare bill; end
users do not need their own R2 accounts.

A signing Worker can begin on Workers Free (100,000 requests/day, 10 ms CPU per
request). Workers Paid currently starts with a $5 monthly subscription and
includes 10 million requests/month, then charges $0.30 per additional million.
Authentication workloads can exceed the Free plan's tight CPU allowance, so
measure before relying on it in production.
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/))

## Upload and abuse controls

- Generate server-chosen, unguessable keys under a per-user/purpose prefix; do
  not accept arbitrary bucket keys from the desktop client.
- Authenticate before signing; rate-limit by stable user/account ID; enforce
  per-user storage and upload-count quotas.
- Allowlist media MIME types and sign the intended `Content-Type`. R2 includes
  this header in the signature, so a mismatched upload fails. Treat all claimed
  client metadata as untrusted and verify actual size/type after upload before
  returning the Instagram `GET` URL.
- Keep both `PUT` and `GET` signatures short-lived and single-object. Do not log
  full presigned URLs because the signature is a bearer credential.
- Delete failed, canceled, and successfully ingested uploads explicitly, with
  lifecycle expiration covering crash/abandonment cases.
- For the current image MVP, use a conservative application-level file cap.
  For future large video uploads, direct-to-R2 avoids proxying bytes through the
  Worker. R2 supports a 5 GiB single upload and multipart objects up to about
  5 TiB, while Cloudflare-account request bodies passing through a Worker are
  limited to 100 MB on Free/Pro plans. Meta's official Reels collection lists a
  1 GB maximum video file, so validate against Instagram's stricter media rules.
  ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
  [Workers request limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Meta Reels publishing](https://www.postman.com/meta/instagram/folder/y6xustx/reels-publishing))

R2 automatically encrypts objects and metadata at rest with AES-256 and secures
transfers with TLS. This does not remove the product obligation to disclose the
temporary cloud upload and retention behavior to users.
([R2 data security](https://developers.cloudflare.com/r2/reference/data-security/))

## End-user experience and product consequences

Users do **not** configure Cloudflare or see R2 credentials. In Compose they
choose a local file, see validation and upload progress, and then publish as
usual. They need an Internet connection while the app stages the file and while
Instagram ingests it. Failure states should say whether upload, Instagram
ingestion, or publishing failed, and support retry without silently creating
duplicate posts.

The privacy change should be explicit: a selected file leaves the computer,
lives temporarily in the app owner's Cloudflare account, and is accessible to
anyone holding its hard-to-guess signed URL until that URL expires. The privacy
policy should identify Cloudflare as a processor/subprocessor, state retention,
and explain deletion. Draft-only media can remain local and should not upload
until the user publishes or schedules it.

R2 fixes media reachability; it does **not** make local scheduling reliable when
the laptop is asleep. For the current local scheduler, stage shortly before the
scheduled publish and require the app to be running and online. A later
"publishes while my laptop is closed" feature still requires a cloud scheduler,
durable job state, and server-side access to the user's Instagram authorization;
scheduled media must then be retained until the job completes.
