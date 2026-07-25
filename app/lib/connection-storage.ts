import { appDatabase as db } from "./app-database";
import {
  assertConnectionId,
  type Connection,
  type ConnectionCredentialMetadata,
  type ConnectionHealth,
  type DeliveryCapabilities,
  type Platform,
} from "./social-content";

export interface StoredConnection extends Connection {
  createdAt: number;
  updatedAt: number;
}

interface ConnectionRow {
  id: string;
  platform: Platform;
  external_account_id: string | null;
  display_name: string;
  health: ConnectionHealth;
  capabilities_json: string | null;
  credential_metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export async function loadStoredConnections(): Promise<StoredConnection[]> {
  const rows = await (await db()).select<ConnectionRow[]>(
    "SELECT * FROM connections ORDER BY platform, display_name, created_at",
  );
  return rows.map(rowToConnection);
}

export async function saveStoredConnection(connection: StoredConnection): Promise<void> {
  assertConnection(connection);
  await (await db()).execute(
    `INSERT INTO connections
      (id, platform, external_account_id, display_name, health, capabilities_json,
       credential_metadata_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       platform = excluded.platform,
       external_account_id = excluded.external_account_id,
       display_name = excluded.display_name,
       health = excluded.health,
       capabilities_json = excluded.capabilities_json,
       credential_metadata_json = excluded.credential_metadata_json,
       updated_at = excluded.updated_at`,
    connectionParams(connection),
  );
}

// Disconnecting a destination must preserve its deliveries and their audit
// trail. The credential is removed separately from its scoped keychain entry.
export async function markStoredConnectionDisconnected(id: string, updatedAt: number): Promise<void> {
  assertConnectionId(id);
  const result = await (await db()).execute(
    "UPDATE connections SET health = 'disconnected', updated_at = $2 WHERE id = $1",
    [id, updatedAt],
  );
  if (result.rowsAffected !== 1) throw new Error("The connection no longer exists.");
}

function connectionParams(connection: StoredConnection): unknown[] {
  return [
    connection.id,
    connection.platform,
    connection.externalIdentityId ?? null,
    connection.displayName,
    connection.health,
    connection.capabilities ? JSON.stringify(connection.capabilities) : null,
    connection.credentialMetadata ? JSON.stringify(validCredentialMetadata(connection.credentialMetadata)) : null,
    connection.createdAt,
    connection.updatedAt,
  ];
}

function rowToConnection(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    platform: row.platform,
    displayName: row.display_name,
    health: row.health,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.external_account_id ? { externalIdentityId: row.external_account_id } : {}),
    ...(row.capabilities_json
      ? { capabilities: parseJson<DeliveryCapabilities>(row.capabilities_json, `connection ${row.id} capabilities`) }
      : {}),
    ...(row.credential_metadata_json
      ? { credentialMetadata: parseCredentialMetadata(row.credential_metadata_json, `connection ${row.id} credential metadata`) }
      : {}),
  };
}

function assertConnection(connection: StoredConnection): void {
  assertConnectionId(connection.id);
  if (!connection.platform.trim()) throw new Error("A connection needs a platform.");
  if (!connection.displayName.trim()) throw new Error("A connection needs a display name.");
  if (!Number.isFinite(connection.createdAt) || !Number.isFinite(connection.updatedAt)) {
    throw new Error("A connection needs valid timestamps.");
  }
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Couldn't read ${label}.`);
  }
}

function parseCredentialMetadata(value: string, label: string): ConnectionCredentialMetadata {
  return validCredentialMetadata(parseJson<unknown>(value, label));
}

function validCredentialMetadata(value: unknown): ConnectionCredentialMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connection credential metadata is invalid.");
  }
  const metadata = value as Record<string, unknown>;
  const allowed = new Set(["expiresAt", "expirySource", "lastRefreshedAt"]);
  if (Object.keys(metadata).some((key) => !allowed.has(key))) {
    throw new Error("Connection credential metadata must not contain credential material.");
  }
  if (metadata.expiresAt !== undefined && (typeof metadata.expiresAt !== "number" || !Number.isFinite(metadata.expiresAt))) {
    throw new Error("Connection credential expiry must be a timestamp.");
  }
  if (metadata.lastRefreshedAt !== undefined && (typeof metadata.lastRefreshedAt !== "number" || !Number.isFinite(metadata.lastRefreshedAt))) {
    throw new Error("Connection credential refresh time must be a timestamp.");
  }
  if (metadata.expirySource !== undefined && metadata.expirySource !== "estimated" && metadata.expirySource !== "platform") {
    throw new Error("Connection credential expiry source is invalid.");
  }
  return metadata as ConnectionCredentialMetadata;
}
