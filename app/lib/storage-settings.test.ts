import { beforeEach, describe, expect, it, vi } from "vitest";

const storeValues = new Map<string, unknown>();
const get = vi.fn((key: string) => Promise.resolve(storeValues.get(key)));
const set = vi.fn((key: string, value: unknown) => {
  storeValues.set(key, value);
  return Promise.resolve();
});

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() => Promise.resolve({ get, set })),
}));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { loadSettings, saveSettings } from "./storage";

beforeEach(() => {
  storeValues.clear();
  get.mockClear();
  set.mockClear();
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
