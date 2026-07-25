// Pure credential-state classifier — the decision engine for the credential
// lifecycle of any connection.
//
// Given a connection's stored credential metadata, the current time, and the
// platform's own lifetime policy, it returns what the app should do next. No
// I/O, no Tauri, no fetch: this is a total function of its inputs, so
// orchestration can consult it freely and tests can cover every boundary
// without mocking. Which numbers apply is the adapter's business — a platform
// that issues an hour-long credential is classified by these same rules.

import type { ConnectionCredentialMetadata, CredentialLifetimePolicy } from "./social-content";

export type CredentialState =
  | "healthy" // nothing to do (also: unknown expiry — lean on the reactive path)
  | "needs-refresh" // eligible and approaching expiry — refresh now
  | "expired"; // lapsed — enter the reconnect state

// Classify a credential from its recorded expiry and the current time. Absent
// metadata means "unknown" (for example, a connection saved by an older app
// version), so it stays `healthy` here and relies on the reactive path — an
// authentication failure on the next call — to notice a lapse.
export function classifyCredential(
  metadata: ConnectionCredentialMetadata | null | undefined,
  now: number,
  policy: CredentialLifetimePolicy,
): CredentialState {
  const expiresAt = metadata?.expiresAt;
  if (metadata == null || expiresAt == null) return "healthy";
  if (now >= expiresAt) return "expired";

  // An estimated expiry means the platform never told us when the credential was
  // issued, so the moment it was connected is the only lower bound we have on its
  // age. Refresh as soon as that bound clears the platform's floor; the first
  // successful refresh replaces the estimate with the platform's own expiry and
  // restores the normal refresh window.
  if (metadata.expirySource === "estimated") {
    const connectedAt = expiresAt - policy.assumedLifetimeMs;
    return now - connectedAt >= policy.refreshFloorMs ? "needs-refresh" : "healthy";
  }

  const remaining = expiresAt - now;
  const age = policy.assumedLifetimeMs - remaining;

  const withinRefreshWindow = remaining <= policy.refreshWindowMs;
  const oldEnough = age >= policy.refreshFloorMs;

  if (withinRefreshWindow && oldEnough) return "needs-refresh";
  return "healthy";
}
