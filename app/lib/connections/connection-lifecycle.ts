// The connection lifecycle, in platform-neutral terms.
//
// Authorizing a destination, keeping its credential alive, and reading a failure
// as a verdict on that credential are the same operations for every platform;
// only the outward calls differ, and those belong to the adapter. This module
// owns what surrounds them: which connection ID a destination gets, what the
// stored connection records, and the order in which the secret and the
// connection are persisted.
//
// The secret itself only ever moves between the adapter and the keychain — it is
// never written to SQLite and never returned as part of a connection.

import { saveStoredConnection, type StoredConnection } from "./connection-storage";
import { classifyCredential } from "./credential-state";
import { platformAdapterFor, requirePlatformAdapter } from "../platforms/registry";
import { setConnectionToken } from "../persistence/storage";
import {
  assertConnectionId,
  type ConnectionIdentity,
  type CredentialFailure,
  type Platform,
  type SocialPlatformAdapter,
} from "../content/social-content";

export interface ConnectedDestination {
  connection: StoredConnection;
  identity: ConnectionIdentity;
  // The credential now in the keychain, handed back so the caller can use the
  // connection immediately without reading the secret store again.
  secret: string;
}

export interface ConnectDestinationInput {
  platform: Platform;
  secret: string;
  // Reconnecting keeps the existing connection's ID and creation time so the
  // deliveries already pointed at it survive with their audit trail.
  existing?: StoredConnection;
  now: number;
}

// The verdict on a connection's credential. "usable" carries the secret to use
// for this operation, whether or not it was rolled forward.
export type CredentialCheck =
  | { state: "usable"; secret: string }
  | { state: "refreshed"; secret: string; connection: StoredConnection }
  | { state: "unusable"; failure: CredentialFailure };

interface ConnectionLifecycleDependencies {
  resolveAdapter: (platform: Platform) => SocialPlatformAdapter;
  saveConnection: typeof saveStoredConnection;
  saveCredential: typeof setConnectionToken;
}

const DEFAULT_DEPENDENCIES: ConnectionLifecycleDependencies = {
  resolveAdapter: requirePlatformAdapter,
  saveConnection: saveStoredConnection,
  saveCredential: setConnectionToken,
};

// Authorize a destination and record it. Used identically by a first connection
// and by a reconnect, because a reconnect is the same exchange against a
// connection that already exists.
export async function connectDestination(
  input: ConnectDestinationInput,
  dependencyOverrides: Partial<ConnectionLifecycleDependencies> = {},
): Promise<ConnectedDestination> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const secret = input.secret.trim();
  if (!secret) throw new Error("Enter the credential for this destination.");
  const adapter = dependencies.resolveAdapter(input.platform);
  const { identity, credential } = await adapter.establishConnection(secret, input.now);

  // Reconnecting must not silently repoint existing deliveries at a different
  // account: the credential has to belong to the account this connection
  // publishes to.
  if (
    input.existing?.externalIdentityId &&
    input.existing.externalIdentityId !== identity.externalIdentityId
  ) {
    throw new Error(
      `This credential is for ${identity.displayName}, but this connection publishes to ${input.existing.displayName}. Add it as a separate connection instead.`,
    );
  }

  const connection: StoredConnection = {
    id: input.existing?.id ?? connectionIdFor(adapter.platform, identity.externalIdentityId),
    platform: adapter.platform,
    externalIdentityId: identity.externalIdentityId,
    displayName: identity.displayName,
    health: "ready",
    capabilities: adapter.capabilities,
    credentialMetadata: credential.metadata,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };

  // The credential lands in the keychain first: a connection recorded as ready
  // without a usable secret would invite publishing attempts that cannot work.
  await dependencies.saveCredential(connection.id, credential.secret);
  await dependencies.saveConnection(connection);
  return { connection, identity, secret: credential.secret };
}

// Consult the platform's lifetime policy and roll the credential forward when it
// is eligible and approaching expiry. A platform that declines for any reason
// other than an authentication verdict leaves the current credential in use: not
// yet eligible and a transient network error are both non-events here.
export async function ensureUsableCredential(
  connection: StoredConnection,
  secret: string,
  now: number,
  dependencyOverrides: Partial<ConnectionLifecycleDependencies> = {},
): Promise<CredentialCheck> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const adapter = dependencies.resolveAdapter(connection.platform);
  const state = classifyCredential(connection.credentialMetadata, now, adapter.credentialLifetime);
  if (state === "expired") return { state: "unusable", failure: "expired" };
  if (state === "healthy") return { state: "usable", secret };

  let credential;
  try {
    credential = await adapter.refreshCredential(secret, now);
  } catch (error) {
    const failure = adapter.classifyCredentialFailure(error);
    return failure ? { state: "unusable", failure } : { state: "usable", secret };
  }

  const refreshed: StoredConnection = {
    ...connection,
    health: "ready",
    credentialMetadata: credential.metadata,
    updatedAt: now,
  };
  await dependencies.saveCredential(connection.id, credential.secret);
  await dependencies.saveConnection(refreshed);
  return { state: "refreshed", secret: credential.secret, connection: refreshed };
}

// Read an arbitrary failure as a verdict on the platform's credential, so the
// shell can drop into its reconnect state without knowing any platform's errors.
// A platform with no adapter in this build has no verdict to give.
export function credentialFailureFor(
  platform: Platform,
  error: unknown,
): CredentialFailure | undefined {
  return platformAdapterFor(platform)?.classifyCredentialFailure(error);
}

// A connection ID is derived from the platform and the account's own ID so
// reconnecting the same account reuses its connection rather than orphaning the
// deliveries already addressed to it. Platform IDs are opaque, so anything
// outside the stored ID's alphabet is folded to an underscore.
function connectionIdFor(platform: Platform, externalIdentityId: string): string {
  const id = `${platform}-${externalIdentityId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  assertConnectionId(id);
  return id;
}
