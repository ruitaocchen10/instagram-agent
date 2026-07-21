// Local persistence layer.
//
// Split by sensitivity and shape:
//   - the access token is a secret → OS keychain in RELEASE builds, via the Rust
//     commands in src-tauri/src/lib.rs (save_token / get_token / delete_token).
//     In DEV builds it lives in app.json instead (see below) to avoid a Keychain
//     permission prompt on every launch — unsigned dev binaries change signature
//     each rebuild, so macOS re-prompts and "Always Allow" never sticks.
//   - app-owned posts (drafts + scheduled) are relational/queryable → SQLite
//     (tauri-plugin-sql), file `app.db` in the app data dir. Published posts are
//     Instagram-owned and fetched from the Graph API, so they are NOT stored here.
//   - connected account + settings are small singletons → tauri-plugin-store,
//     a plaintext JSON file in the app data dir.

import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { ApiMode } from "./instagram";
import type { Account, Post } from "./types";
import {
  claimedScheduledPost,
  failedScheduledPost,
  publishingScheduledPost,
  uncertainScheduledPost,
} from "./scheduled-publisher";
import { appDatabase as db, inTransaction } from "./app-database";

// ── Token ──────────────────────────────────────────────────────────────────
//
// DEV: token in app.json (plaintext, but dev-only) → no Keychain prompt.
// RELEASE: token in the OS keychain via the Rust commands.
// `process.env.NODE_ENV` is "development" under `tauri dev`, "production" in the
// static export shipped in the bundle — Next inlines it at build time.

const IS_DEV = process.env.NODE_ENV !== "production";
const KEY_DEV_TOKEN = "dev_access_token";

export async function getToken(): Promise<string | null> {
  if (IS_DEV) return (await (await store()).get<string>(KEY_DEV_TOKEN)) ?? null;
  return (await invoke<string | null>("get_token")) ?? null;
}

export async function setToken(token: string): Promise<void> {
  if (IS_DEV) {
    await (await store()).set(KEY_DEV_TOKEN, token);
    return;
  }
  await invoke("save_token", { token });
}

export async function clearToken(): Promise<void> {
  if (IS_DEV) {
    await (await store()).delete(KEY_DEV_TOKEN);
    return;
  }
  await invoke("delete_token");
}

// ── Store (plaintext JSON) ─────────────────────────────────────────────────

export interface Settings {
  mode: ApiMode;
  version: string;
}

const STORE_FILE = "app.json";
const KEY_ACCOUNT = "account";
const KEY_SETTINGS = "settings";
const KEY_TOKEN_EXPIRY = "token_expiry"; // absolute epoch ms, non-secret

let storePromise: Promise<Store> | null = null;

// Lazily open (and cache) the single store file. `autoSave` flushes writes to
// disk shortly after each `set`, so callers don't have to manage persistence.
function store(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

export async function loadAccount(): Promise<Account | null> {
  return (await (await store()).get<Account>(KEY_ACCOUNT)) ?? null;
}

export async function saveAccount(account: Account): Promise<void> {
  await (await store()).set(KEY_ACCOUNT, account);
}

export async function clearAccount(): Promise<void> {
  await (await store()).delete(KEY_ACCOUNT);
}

// ── Token expiry (non-secret metadata) ──────────────────────────────────────
//
// The absolute time (epoch ms) the current token expires, derived from the
// `expires_in` a refresh returns. This is NOT a secret, so it lives in the
// plaintext store beside the account — never in the keychain, never in SQLite.
// It is `null` when the app only ever received a raw pasted token (no
// `expires_in`), in which case expiry is treated as unknown.

export async function loadTokenExpiry(): Promise<number | null> {
  return (await (await store()).get<number>(KEY_TOKEN_EXPIRY)) ?? null;
}

export async function saveTokenExpiry(expiryTs: number): Promise<void> {
  await (await store()).set(KEY_TOKEN_EXPIRY, expiryTs);
}

export async function clearTokenExpiry(): Promise<void> {
  await (await store()).delete(KEY_TOKEN_EXPIRY);
}

export async function loadSettings(): Promise<Settings | null> {
  return (await (await store()).get<Settings>(KEY_SETTINGS)) ?? null;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await store()).set(KEY_SETTINGS, settings);
}

// ── Follower history (for the dashboard's week-over-week delta) ───────────
//
// One snapshot per calendar day (local time), capped so the file can't grow
// unbounded. 35 days is enough headroom for a 7d delta plus some slack for
// days the app wasn't opened.

interface FollowerSnapshot {
  date: string; // YYYY-MM-DD, local time
  followers: number;
}

const KEY_FOLLOWER_HISTORY = "follower_history";
const FOLLOWER_HISTORY_MAX_DAYS = 35;
const DELTA_LOOKBACK_DAYS = 7;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// Record today's follower count, once per day. A no-op if today's snapshot
// already exists, so callers can invoke this on every account refresh.
export async function recordFollowerSnapshot(followers: number): Promise<void> {
  const s = await store();
  const history = (await s.get<FollowerSnapshot[]>(KEY_FOLLOWER_HISTORY)) ?? [];
  const today = todayKey();
  if (history.some((h) => h.date === today)) return;
  const next = [...history, { date: today, followers }].slice(-FOLLOWER_HISTORY_MAX_DAYS);
  await s.set(KEY_FOLLOWER_HISTORY, next);
}

// Percent change vs. the snapshot closest to (but not after) 7 days ago.
// `null` when there isn't yet a snapshot old enough to compare against.
export async function getFollowerDelta(
  current: number,
): Promise<{ pct: number; direction: "up" | "down" } | null> {
  const history = (await (await store()).get<FollowerSnapshot[]>(KEY_FOLLOWER_HISTORY)) ?? [];
  if (history.length === 0) return null;

  const cutoff = Date.now() - DELTA_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const eligible = history.filter((h) => new Date(h.date).getTime() <= cutoff);
  if (eligible.length === 0) return null;

  const baseline = eligible[eligible.length - 1];
  if (baseline.followers === 0) return null;

  const pct = ((current - baseline.followers) / baseline.followers) * 100;
  return { pct: Math.abs(pct), direction: pct >= 0 ? "up" : "down" };
}

// ── Posts (SQLite) ─────────────────────────────────────────────────────────
//
// Only app-owned posts live here: drafts and scheduled posts. Published posts
// come from Instagram and are never written to this table.

// Row shape as returned by SQLite (snake_case columns, NULL for absent numbers).
interface PostRow {
  id: string;
  image_url: string;
  caption: string;
  status: Post["status"];
  scheduled_at: number | null;
  published_at: number | null;
  likes: number | null;
  comments: number | null;
  updated_at: number;
  publish_state: Post["publishState"] | null;
  publish_error: string | null;
  publish_attempted_at: number | null;
}

function rowToPost(r: PostRow): Post {
  return {
    id: r.id,
    imageUrl: r.image_url,
    caption: r.caption,
    status: r.status,
    scheduledAt: r.scheduled_at ?? undefined,
    publishedAt: r.published_at ?? undefined,
    likes: r.likes ?? undefined,
    comments: r.comments ?? undefined,
    updatedAt: r.updated_at,
    publishState: r.publish_state ?? "idle",
    publishError: r.publish_error ?? undefined,
    publishAttemptedAt: r.publish_attempted_at ?? undefined,
  };
}

// All locally stored posts (drafts + scheduled), most-recently-updated first.
export async function loadPosts(): Promise<Post[]> {
  const connection = await db();
  await connection.execute(
    `UPDATE posts
        SET publish_state = 'failed',
            publish_error = COALESCE(
              publish_error,
              'Publishing stopped before Instagram was contacted. Retrying automatically.'
            )
      WHERE status = 'scheduled' AND publish_state = 'claimed'`,
  );
  await connection.execute(
    `UPDATE posts
        SET publish_state = 'uncertain',
            publish_error = COALESCE(
              publish_error,
              'Publishing was interrupted before the result was recorded. Check Instagram before rescheduling.'
            )
      WHERE status = 'scheduled' AND publish_state = 'publishing'`,
  );
  const rows = await connection.select<PostRow[]>(
    "SELECT * FROM posts WHERE status <> 'published' ORDER BY updated_at DESC",
  );
  return rows.map(rowToPost);
}

// Upsert one post by id. Stamps updatedAt if the caller didn't.
export async function savePost(post: Post): Promise<void> {
  const updatedAt = post.updatedAt ?? Date.now();
  await (await db()).execute(
    `INSERT INTO posts
       (id, image_url, caption, status, scheduled_at, published_at, likes, comments, updated_at,
        publish_state, publish_error, publish_attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT(id) DO UPDATE SET
       image_url = excluded.image_url,
       caption = excluded.caption,
       status = excluded.status,
       scheduled_at = excluded.scheduled_at,
       published_at = excluded.published_at,
       likes = excluded.likes,
       comments = excluded.comments,
       updated_at = excluded.updated_at,
       publish_state = excluded.publish_state,
       publish_error = excluded.publish_error,
       publish_attempted_at = excluded.publish_attempted_at`,
    [
      post.id,
      post.imageUrl,
      post.caption,
      post.status,
      post.scheduledAt ?? null,
      post.publishedAt ?? null,
      post.likes ?? null,
      post.comments ?? null,
      updatedAt,
      post.publishState ?? "idle",
      post.publishError ?? null,
      post.publishAttemptedAt ?? null,
    ],
  );
}

// Atomically claim a scheduled row before any Instagram mutation, whether the
// caller is the scheduler, composer, or copilot. A persisted claim makes every
// publishing path contend on the same duplicate-prevention boundary.
export async function claimScheduledPost(
  post: Post,
  attemptedAt: number,
): Promise<Post | null> {
  if (post.status !== "scheduled" || !Number.isFinite(post.scheduledAt)) return null;
  const result = await (await db()).execute(
    `UPDATE posts
        SET publish_state = 'claimed',
            publish_error = NULL,
            publish_attempted_at = $3,
            updated_at = $3
      WHERE id = $1
        AND status = 'scheduled'
        AND scheduled_at = $2
        AND COALESCE(publish_state, 'idle') IN ('idle', 'failed')`,
    [post.id, post.scheduledAt!, attemptedAt],
  );
  return result.rowsAffected === 1 ? claimedScheduledPost(post, attemptedAt) : null;
}

export async function startScheduledPublish(post: Post, attemptedAt: number): Promise<Post> {
  const result = await (await db()).execute(
    `UPDATE posts
        SET publish_state = 'publishing', updated_at = $2
      WHERE id = $1 AND status = 'scheduled' AND publish_state = 'claimed'`,
    [post.id, attemptedAt],
  );
  if (result.rowsAffected !== 1) {
    throw new Error("The scheduled post no longer has the expected pre-publish claim.");
  }
  return publishingScheduledPost(post, attemptedAt);
}

async function recordScheduledPublishState(
  post: Post,
  state: "failed" | "uncertain",
  error: string,
  attemptedAt: number,
): Promise<void> {
  const result = await (await db()).execute(
    `UPDATE posts
        SET publish_state = $2,
            publish_error = $3,
            publish_attempted_at = $4,
            updated_at = $4
      WHERE id = $1
        AND status = 'scheduled'
        AND publish_state IN ('claimed', 'publishing')`,
    [post.id, state, error, attemptedAt],
  );
  if (result.rowsAffected !== 1) {
    throw new Error("The scheduled post no longer has the expected publishing claim.");
  }
}

// Serialize a reschedule with the scheduler's atomic claim. If the claim wins,
// the edit is rejected; if the edit wins, a claimant using the old timestamp
// cannot match the row after this transaction commits.
export async function reschedulePost(post: Post): Promise<void> {
  await inTransaction(async () => {
    const connection = await db();
    const rows = await connection.select<{ publish_state: Post["publishState"] | null }[]>(
      "SELECT publish_state FROM posts WHERE id = $1 AND status = 'scheduled'",
      [post.id],
    );
    if (
      rows[0]?.publish_state === "claimed" ||
      rows[0]?.publish_state === "publishing"
    ) {
      throw new Error("This post is already being published and cannot be rescheduled.");
    }
    await savePost(post);
  });
}

export async function recordScheduledPublishFailure(
  post: Post,
  error: string,
  attemptedAt: number,
): Promise<Post> {
  await recordScheduledPublishState(post, "failed", error, attemptedAt);
  return failedScheduledPost(post, error, attemptedAt);
}

export async function recordScheduledPublishUncertain(
  post: Post,
  error: string,
  attemptedAt: number,
): Promise<Post> {
  await recordScheduledPublishState(post, "uncertain", error, attemptedAt);
  return uncertainScheduledPost(post, error, attemptedAt);
}

export async function deletePost(id: string): Promise<void> {
  await (await db()).execute("DELETE FROM posts WHERE id = $1", [id]);
}

// True when no posts have ever been stored — used to gate first-run seeding.
export async function isPostStoreEmpty(): Promise<boolean> {
  const rows = await (await db()).select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM posts",
  );
  return (rows[0]?.n ?? 0) === 0;
}
