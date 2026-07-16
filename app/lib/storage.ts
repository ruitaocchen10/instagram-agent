// Local persistence layer.
//
// Split by sensitivity:
//   - the access token is a secret → OS keychain, via the Rust commands in
//     src-tauri/src/lib.rs (save_token / get_token / delete_token).
//   - everything else (connected account, settings, drafts) is non-secret →
//     tauri-plugin-store, a plaintext JSON file in the app data dir.

import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { Account, ApiMode } from "./instagram";

// ── Token (OS keychain) ────────────────────────────────────────────────────

export async function getToken(): Promise<string | null> {
  return (await invoke<string | null>("get_token")) ?? null;
}

export async function setToken(token: string): Promise<void> {
  await invoke("save_token", { token });
}

export async function clearToken(): Promise<void> {
  await invoke("delete_token");
}

// ── Store (plaintext JSON) ─────────────────────────────────────────────────

export interface Settings {
  mode: ApiMode;
  version: string;
}

export interface Draft {
  id: string;
  imageUrl: string;
  caption: string;
  updatedAt: number;
}

const STORE_FILE = "app.json";
const KEY_ACCOUNT = "account";
const KEY_SETTINGS = "settings";
const KEY_DRAFTS = "drafts";

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

export async function loadSettings(): Promise<Settings | null> {
  return (await (await store()).get<Settings>(KEY_SETTINGS)) ?? null;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await store()).set(KEY_SETTINGS, settings);
}

export async function loadDrafts(): Promise<Draft[]> {
  return (await (await store()).get<Draft[]>(KEY_DRAFTS)) ?? [];
}

// Upsert by id and persist the whole list, most-recently-updated first.
export async function saveDraft(draft: Draft): Promise<Draft[]> {
  const drafts = await loadDrafts();
  const next = [draft, ...drafts.filter((d) => d.id !== draft.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  await (await store()).set(KEY_DRAFTS, next);
  return next;
}

export async function deleteDraft(id: string): Promise<Draft[]> {
  const next = (await loadDrafts()).filter((d) => d.id !== id);
  await (await store()).set(KEY_DRAFTS, next);
  return next;
}
