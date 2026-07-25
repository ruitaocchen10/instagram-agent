import { beforeEach, describe, expect, it, vi } from "vitest";

const storeValues = new Map<string, unknown>();
const get = vi.fn((key: string) => Promise.resolve(storeValues.get(key)));
const set = vi.fn((key: string, value: unknown) => {
  storeValues.set(key, value);
  return Promise.resolve();
});
const has = vi.fn((key: string) => Promise.resolve(storeValues.has(key)));
const del = vi.fn((key: string) => Promise.resolve(storeValues.delete(key)));
const save = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() => Promise.resolve({ get, set, has, delete: del, save })),
}));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { loadSettings, pruneRetiredStoreKeys, saveSettings } from "./storage";

beforeEach(() => {
  storeValues.clear();
  get.mockClear();
  set.mockClear();
  has.mockClear();
  del.mockClear();
  save.mockClear();
});

describe("settings storage", () => {
  it("migrates settings written before appearance was persisted", async () => {
    storeValues.set("settings", { mode: "instagram", version: "v21.0" });

    await expect(loadSettings()).resolves.toEqual({
      mode: "instagram",
      version: "v21.0",
      theme: "light",
    });
  });

  it("restores a saved dark theme on the next load", async () => {
    await saveSettings({ mode: "instagram", version: "v21.0", theme: "dark" });

    await expect(loadSettings()).resolves.toEqual({
      mode: "instagram",
      version: "v21.0",
      theme: "dark",
    });
  });
});

describe("pruning what the retired singleton connection left behind", () => {
  it("removes the stored credential, account, and expiry", async () => {
    storeValues.set("dev_access_token", "IGAA-a-real-looking-token");
    storeValues.set("account", { username: "creator" });
    storeValues.set("token_expiry", { expiresAt: 1, source: "meta" });
    storeValues.set("settings", { mode: "instagram", version: "v21.0", theme: "dark" });
    storeValues.set("follower_history", [{ date: "2026-07-01", followers: 5 }]);

    await pruneRetiredStoreKeys();

    // A credential belongs only in the OS keychain, never in the plaintext file.
    expect(storeValues.has("dev_access_token")).toBe(false);
    expect(storeValues.has("account")).toBe(false);
    expect(storeValues.has("token_expiry")).toBe(false);
    // Everything the application still owns survives untouched.
    expect(storeValues.get("settings")).toEqual({
      mode: "instagram",
      version: "v21.0",
      theme: "dark",
    });
    expect(storeValues.get("follower_history")).toEqual([{ date: "2026-07-01", followers: 5 }]);
  });

  it("flushes the deletion rather than leaving it to the autosave debounce", async () => {
    storeValues.set("dev_access_token", "IGAA-a-real-looking-token");

    await pruneRetiredStoreKeys();

    expect(save).toHaveBeenCalled();
  });

  it("writes nothing when there is nothing left to remove", async () => {
    storeValues.set("settings", { mode: "instagram", version: "v21.0", theme: "light" });

    await pruneRetiredStoreKeys();

    expect(del).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
