// /app/__tests__/leadHousekeeping.test.ts
//
// PLACEHOLDER TEST — Grade: A (pure helpers only). The Prisma mock
// below is an isolation shim — the imports tested here
// (`daysSinceLastAction`, `leadTemperature`, the threshold constants)
// are pure functions taking literal input. No SQL exercised.
//
// HISTORY: this file used to also contain mocked-Prisma orchestration
// tests for `autoArchiveStaleLeads` and `computeNeedsAttention`.
// Those moved to __tests__/integration/leadHousekeeping.integration.test.ts
// (Phase 0.6.3, 2026-05-01) where they exercise real Postgres queries.

jest.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  daysSinceLastAction,
  leadTemperature,
  STALE_AFTER_DAYS,
  ARCHIVE_AFTER_DAYS,
  autoArchiveStaleLeads,
  computeNeedsAttention,
} from "../src/lib/leadHousekeeping";

describe("daysSinceLastAction", () => {
  it("returns 0 for just now", () => {
    const now = new Date("2026-04-22T10:00:00Z");
    expect(daysSinceLastAction(now, now)).toBe(0);
  });

  it("returns the correct day count", () => {
    const now = new Date("2026-04-22T10:00:00Z");
    const then = new Date("2026-04-15T10:00:00Z");
    expect(daysSinceLastAction(then, now)).toBe(7);
  });

  it("returns a very large number for null lastActionAt", () => {
    expect(daysSinceLastAction(null)).toBeGreaterThan(1000);
    expect(daysSinceLastAction(undefined)).toBeGreaterThan(1000);
  });

  it("accepts string dates", () => {
    const now = new Date("2026-04-22T10:00:00Z");
    expect(daysSinceLastAction("2026-04-10T10:00:00Z", now)).toBe(12);
  });
});

describe("leadTemperature (boundary tests)", () => {
  const now = new Date("2026-04-22T10:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000);

  it("13 days → active (under STALE_AFTER_DAYS of 14)", () => {
    expect(leadTemperature(daysAgo(13), now)).toBe("active");
  });

  it("14 days → going_stale (at STALE boundary)", () => {
    expect(leadTemperature(daysAgo(14), now)).toBe("going_stale");
  });

  it("15 days → going_stale", () => {
    expect(leadTemperature(daysAgo(15), now)).toBe("going_stale");
  });

  it("29 days → going_stale (just under archive)", () => {
    expect(leadTemperature(daysAgo(29), now)).toBe("going_stale");
  });

  it("30 days → expired (at ARCHIVE boundary)", () => {
    expect(leadTemperature(daysAgo(30), now)).toBe("expired");
  });

  it("31 days → expired", () => {
    expect(leadTemperature(daysAgo(31), now)).toBe("expired");
  });

  it("null lastActionAt → expired (never touched)", () => {
    expect(leadTemperature(null, now)).toBe("expired");
  });
});

describe("constants", () => {
  it("threshold values are what the plan spec says", () => {
    expect(STALE_AFTER_DAYS).toBe(14);
    expect(ARCHIVE_AFTER_DAYS).toBe(30);
  });
});
