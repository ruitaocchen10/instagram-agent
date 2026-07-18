import { describe, it, expect } from "vitest";
import { classifyToken, DEFAULT_POLICY, type TokenStatePolicy } from "./token-state";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 1); // fixed reference "now"

// Helper: an expiry `remaining` ms in the future from NOW.
const expiryIn = (remaining: number) => NOW + remaining;

describe("classifyToken", () => {
  it("treats an unknown (null/undefined) expiry as healthy — no proactive action", () => {
    expect(classifyToken(null, NOW)).toBe("healthy");
    expect(classifyToken(undefined, NOW)).toBe("healthy");
  });

  it("is expired at or after the expiry instant", () => {
    expect(classifyToken(NOW, NOW)).toBe("expired"); // exactly at expiry
    expect(classifyToken(NOW - 1, NOW)).toBe("expired"); // just past
    expect(classifyToken(NOW - 30 * DAY, NOW)).toBe("expired"); // long gone
  });

  it("is healthy for a freshly-issued long-lived token (younger than 24h)", () => {
    // A brand-new 60-day token: ~60d remaining, age ~0 → too young to refresh,
    // and nowhere near expiry. Must not be flagged needs-refresh.
    expect(classifyToken(expiryIn(60 * DAY), NOW)).toBe("healthy");
    expect(classifyToken(expiryIn(60 * DAY - 12 * HOUR), NOW)).toBe("healthy");
  });

  it("is healthy in the comfortable middle of the 60-day window", () => {
    expect(classifyToken(expiryIn(30 * DAY), NOW)).toBe("healthy");
    expect(classifyToken(expiryIn(11 * DAY), NOW)).toBe("healthy");
  });

  it("needs refresh once inside the pre-expiry window (and old enough)", () => {
    expect(classifyToken(expiryIn(10 * DAY), NOW)).toBe("needs-refresh"); // window edge
    expect(classifyToken(expiryIn(5 * DAY), NOW)).toBe("needs-refresh");
    expect(classifyToken(expiryIn(1 * HOUR), NOW)).toBe("needs-refresh");
  });

  it("respects the 24h refresh floor even when inside an aggressive window", () => {
    // A wide window that would otherwise catch a fresh token: the floor keeps a
    // <24h-old token healthy, matching Meta's 'must be >=24h old' rule.
    const aggressive: TokenStatePolicy = {
      ...DEFAULT_POLICY,
      refreshWindowMs: 59 * DAY, // window covers all but the first day
    };
    // Fresh token: age ~1h (<24h) → healthy despite being "in window".
    expect(classifyToken(expiryIn(60 * DAY - HOUR), NOW, aggressive)).toBe("healthy");
    // Same window, but now old enough (age 2 days) → needs-refresh.
    expect(classifyToken(expiryIn(58 * DAY), NOW, aggressive)).toBe("needs-refresh");
  });

  it("handles the exact 24h floor boundary as eligible", () => {
    const aggressive: TokenStatePolicy = { ...DEFAULT_POLICY, refreshWindowMs: 59 * DAY };
    // age exactly 24h → oldEnough (>=) → needs-refresh.
    expect(classifyToken(expiryIn(59 * DAY), NOW, aggressive)).toBe("needs-refresh");
  });
});
