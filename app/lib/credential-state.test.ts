import { describe, it, expect } from "vitest";
import { classifyCredential } from "./credential-state";
import type { ConnectionCredentialMetadata, CredentialLifetimePolicy } from "./social-content";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 1); // fixed reference "now"

// Instagram's policy stands in for a real platform's rule: a 60-day credential,
// refreshable once it is 24 hours old, rolled forward inside the last 10 days.
const POLICY: CredentialLifetimePolicy = {
  assumedLifetimeMs: 60 * DAY,
  refreshFloorMs: 24 * HOUR,
  refreshWindowMs: 10 * DAY,
};

// Helper: metadata whose expiry is `remaining` ms in the future from NOW, as
// confirmed by the platform itself.
const expiryIn = (remaining: number): ConnectionCredentialMetadata => ({
  expiresAt: NOW + remaining,
  expirySource: "platform",
});

// The same instant, but only estimated from when the credential was connected.
const estimatedExpiryIn = (remaining: number): ConnectionCredentialMetadata => ({
  expiresAt: NOW + remaining,
  expirySource: "estimated",
});

describe("classifyCredential", () => {
  it("treats unknown expiry as healthy — no proactive action", () => {
    expect(classifyCredential(null, NOW, POLICY)).toBe("healthy");
    expect(classifyCredential(undefined, NOW, POLICY)).toBe("healthy");
    expect(classifyCredential({}, NOW, POLICY)).toBe("healthy");
  });

  it("is expired at or after the expiry instant", () => {
    expect(classifyCredential(expiryIn(0), NOW, POLICY)).toBe("expired"); // exactly at expiry
    expect(classifyCredential(expiryIn(-1), NOW, POLICY)).toBe("expired"); // just past
    expect(classifyCredential(expiryIn(-30 * DAY), NOW, POLICY)).toBe("expired"); // long gone
  });

  it("is healthy for a freshly-issued credential (younger than the floor)", () => {
    // A brand-new 60-day credential: ~60d remaining, age ~0 → too young to
    // refresh, and nowhere near expiry. Must not be flagged needs-refresh.
    expect(classifyCredential(expiryIn(60 * DAY), NOW, POLICY)).toBe("healthy");
    expect(classifyCredential(expiryIn(60 * DAY - 12 * HOUR), NOW, POLICY)).toBe("healthy");
  });

  it("is healthy in the comfortable middle of the lifetime", () => {
    expect(classifyCredential(expiryIn(30 * DAY), NOW, POLICY)).toBe("healthy");
    expect(classifyCredential(expiryIn(11 * DAY), NOW, POLICY)).toBe("healthy");
  });

  it("needs refresh once inside the pre-expiry window (and old enough)", () => {
    expect(classifyCredential(expiryIn(10 * DAY), NOW, POLICY)).toBe("needs-refresh"); // window edge
    expect(classifyCredential(expiryIn(5 * DAY), NOW, POLICY)).toBe("needs-refresh");
    expect(classifyCredential(expiryIn(1 * HOUR), NOW, POLICY)).toBe("needs-refresh");
  });

  it("respects the refresh floor even when inside an aggressive window", () => {
    // A wide window that would otherwise catch a fresh credential: the floor
    // keeps it healthy, matching a platform's 'must be >= 24h old' rule.
    const aggressive: CredentialLifetimePolicy = {
      ...POLICY,
      refreshWindowMs: 59 * DAY, // window covers all but the first day
    };
    // Fresh credential: age ~1h (<24h) → healthy despite being "in window".
    expect(classifyCredential(expiryIn(60 * DAY - HOUR), NOW, aggressive)).toBe("healthy");
    // Same window, but now old enough (age 2 days) → needs-refresh.
    expect(classifyCredential(expiryIn(58 * DAY), NOW, aggressive)).toBe("needs-refresh");
  });

  it("handles the exact floor boundary as eligible", () => {
    const aggressive: CredentialLifetimePolicy = { ...POLICY, refreshWindowMs: 59 * DAY };
    // age exactly 24h → oldEnough (>=) → needs-refresh.
    expect(classifyCredential(expiryIn(59 * DAY), NOW, aggressive)).toBe("needs-refresh");
  });

  it("refreshes an estimated expiry as soon as the floor passes", () => {
    // An estimate carries no issue time, so the connection moment is the only
    // lower bound on age: refresh the instant the floor clears rather than
    // waiting for a window that was never authoritative.
    const estimate = estimatedExpiryIn(60 * DAY);
    expect(classifyCredential(estimate, NOW, POLICY)).toBe("healthy");
    expect(classifyCredential(estimate, NOW + DAY - 1, POLICY)).toBe("healthy");
    expect(classifyCredential(estimate, NOW + DAY, POLICY)).toBe("needs-refresh");
    expect(classifyCredential(estimate, NOW + 60 * DAY, POLICY)).toBe("expired");
  });
});
