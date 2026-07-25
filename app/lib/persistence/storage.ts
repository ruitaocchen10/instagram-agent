// Local persistence layer.
//
// Split by sensitivity and shape:
//   - each connection credential is a secret → OS keychain via the Rust
//     connection-scoped credential commands.
//   - settings and follower history are small singletons → tauri-plugin-store,
//     a plaintext JSON file.
//
// App-owned creative work is not here: content and its deliveries are
// relational and live in SQLite behind `content-delivery-storage`.

import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { DEFAULT_CONFIG, type ApiMode } from "../platforms/instagram-api";
import { assertConnectionId } from "../content/social-content";

// ── Connection credentials ─────────────────────────────────────────────────
export async function getConnectionToken(connectionId: string): Promise<string | null> {
  assertConnectionId(connectionId);
  return (await invoke<string | null>("get_connection_token", { connectionId })) ?? null;
}

export async function setConnectionToken(connectionId: string, token: string): Promise<void> {
  assertConnectionId(connectionId);
  await invoke("save_connection_token", { connectionId, token });
}

export async function clearConnectionToken(connectionId: string): Promise<void> {
  assertConnectionId(connectionId);
  await invoke("delete_connection_token", { connectionId });
}

// ── Store (plaintext JSON) ─────────────────────────────────────────────────

export interface Settings {
  mode: ApiMode;
  version: string;
  theme: "light" | "dark";
}

export const DEFAULT_SETTINGS: Settings = { ...DEFAULT_CONFIG, theme: "light" };

const STORE_FILE = "app.json";
const KEY_SETTINGS = "settings";

let storePromise: Promise<Store> | null = null;

// Lazily open (and cache) the single store file. `autoSave` flushes writes to
// disk shortly after each `set`, so callers don't have to manage persistence.
function store(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { defaults: {}, autoSave: true });
  }
  return storePromise;
}

export async function loadSettings(): Promise<Settings | null> {
  const settings = await (await store()).get<Partial<Settings>>(KEY_SETTINGS);
  if (!settings) return null;

  // Settings created by older builds have no appearance preference. Treat
  // those as light mode while preserving the rest of the stored config.
  return {
    mode: settings.mode ?? DEFAULT_SETTINGS.mode,
    version: settings.version ?? DEFAULT_SETTINGS.version,
    theme: settings.theme === "dark" ? "dark" : "light",
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await store()).set(KEY_SETTINGS, settings);
}

// What the retired singleton Instagram connection left in the plaintext store:
// the credential itself, the cached account, and that credential's expiry.
// Retiring the code that wrote them does not remove what they already wrote, and
// no reader is left to notice, so a boot that still finds them clears them out.
// A credential belongs only in the OS keychain.
const RETIRED_STORE_KEYS = ["dev_access_token", "account", "token_expiry"];

export async function pruneRetiredStoreKeys(): Promise<void> {
  const s = await store();
  let removed = false;
  for (const key of RETIRED_STORE_KEYS) {
    if (await s.has(key)) {
      await s.delete(key);
      removed = true;
    }
  }
  // Flush immediately rather than waiting for the autosave debounce: this
  // deletion is the point of the call, not a side effect of one.
  if (removed) await s.save();
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
