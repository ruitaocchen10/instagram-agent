import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.fn();
const execute = vi.fn();
vi.mock("../persistence/app-database", () => ({ appDatabase: vi.fn(() => Promise.resolve({ select, execute })) }));

import {
  loadStoredConnections,
  markStoredConnectionDisconnected,
  saveStoredConnection,
} from "./connection-storage";

beforeEach(() => {
  select.mockReset();
  execute.mockReset();
});

describe("connection storage", () => {
  it("reads durable connection identity and non-secret capability metadata", async () => {
    select.mockResolvedValueOnce([{
      id: "instagram-brand-a",
      platform: "instagram",
      external_account_id: "1784",
      display_name: "@brand-a",
      health: "ready",
      capabilities_json: JSON.stringify({ mediaTypes: ["image", "video"], maxCaptionLength: 2200 }),
      credential_metadata_json: JSON.stringify({ expiresAt: 1234, expirySource: "platform" }),
      created_at: 10,
      updated_at: 20,
    }]);

    await expect(loadStoredConnections()).resolves.toEqual([{
      id: "instagram-brand-a",
      platform: "instagram",
      externalIdentityId: "1784",
      displayName: "@brand-a",
      health: "ready",
      capabilities: { mediaTypes: ["image", "video"], maxCaptionLength: 2200 },
      credentialMetadata: { expiresAt: 1234, expirySource: "platform" },
      createdAt: 10,
      updatedAt: 20,
    }]);
  });

  it("upserts a connection without ever accepting a secret credential", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 1 });
    await saveStoredConnection({
      id: "instagram-brand-a",
      platform: "instagram",
      displayName: "@brand-a",
      health: "ready",
      createdAt: 10,
      updatedAt: 20,
      credentialMetadata: { expiresAt: 1234, expirySource: "platform" },
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(id) DO UPDATE"),
      ["instagram-brand-a", "instagram", null, "@brand-a", "ready", null, JSON.stringify({ expiresAt: 1234, expirySource: "platform" }), 10, 20],
    );
  });

  it("disconnects one connection without deleting its deliveries", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 1 });
    await markStoredConnectionDisconnected("instagram-brand-a", 30);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE connections SET health = 'disconnected'"),
      ["instagram-brand-a", 30],
    );
  });

  it("uses the same ID invariant as the scoped credential keychain", async () => {
    await expect(saveStoredConnection({
      id: "connection/escape",
      platform: "instagram",
      displayName: "@brand-a",
      health: "ready",
      createdAt: 10,
      updatedAt: 20,
    })).rejects.toThrow("connection ID may contain only");
  });

  it("rejects secret-looking metadata before it can reach SQLite", async () => {
    await expect(saveStoredConnection({
      id: "instagram-brand-a",
      platform: "instagram",
      displayName: "@brand-a",
      health: "ready",
      createdAt: 10,
      updatedAt: 20,
      credentialMetadata: { accessToken: "secret" } as never,
    })).rejects.toThrow("must not contain credential material");
    expect(execute).not.toHaveBeenCalled();
  });
});
