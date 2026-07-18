// Pure token-state classifier — the decision engine for token lifecycle.
//
// Given the stored absolute expiry timestamp and the current time, it returns
// what the app should do next. No I/O, no Tauri, no fetch: this is a total
// function of its inputs, so orchestration can consult it freely and tests can
// cover every boundary without mocking.
//
// The three-stage token lifecycle (see issue #2):
//   short-lived (~1h) → [manual exchange] → long-lived (60d) → [refresh] → 60d → …
// Only the long→long refresh is the app's job, and Meta only allows it when the
// long-lived token is at least 24h old and not yet expired. We model that rule
// here so orchestration never fires an ineligible refresh.

export type TokenState =
  | "healthy" // nothing to do (also: unknown expiry — lean on the reactive path)
  | "needs-refresh" // eligible and approaching expiry — refresh now
  | "expired"; // lapsed — enter the reconnect state

export interface TokenStatePolicy {
  // Assumed lifetime of a freshly-issued long-lived token. Used to derive the
  // token's age from its expiry, so we can honor Meta's 24h floor.
  longLivedLifetimeMs: number;
  // Minimum age before a refresh is allowed (Meta's rule: >= 24h old).
  refreshFloorMs: number;
  // How close to expiry we start refreshing.
  refreshWindowMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEFAULT_POLICY: TokenStatePolicy = {
  longLivedLifetimeMs: 60 * DAY,
  refreshFloorMs: 24 * HOUR,
  refreshWindowMs: 10 * DAY,
};

// Classify a token from its absolute expiry (epoch ms) and the current time.
// A null/undefined expiry means "unknown" — the app only learns a real expiry
// after a refresh, so raw pasted tokens stay `healthy` here and rely on the
// reactive code-190 path to detect a lapse.
export function classifyToken(
  expiryTs: number | null | undefined,
  now: number,
  policy: TokenStatePolicy = DEFAULT_POLICY,
): TokenState {
  if (expiryTs == null) return "healthy";
  if (now >= expiryTs) return "expired";

  const remaining = expiryTs - now;
  const age = policy.longLivedLifetimeMs - remaining;

  const withinRefreshWindow = remaining <= policy.refreshWindowMs;
  const oldEnough = age >= policy.refreshFloorMs;

  if (withinRefreshWindow && oldEnough) return "needs-refresh";
  return "healthy";
}
