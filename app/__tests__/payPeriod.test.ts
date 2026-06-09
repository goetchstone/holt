// /app/__tests__/payPeriod.test.ts
//
// Pure tests for the bi-weekly pay-period math. The anchor is a
// Sunday (2026-05-03, owner-confirmed period 5/03–5/16); periods are
// 14 days, inclusive both ends.

import {
  payPeriodForDate,
  shiftPayPeriod,
  recentPayPeriods,
  payPeriodFromStart,
  formatPeriodDate,
  formatPeriodLabel,
  PAY_PERIOD_ANCHOR_ISO,
} from "../src/lib/payPeriod";

describe("payPeriodForDate", () => {
  it("the anchor day falls in period index 0, starting on the anchor", () => {
    const p = payPeriodForDate(new Date("2026-05-03T12:00:00Z"));
    expect(p.index).toBe(0);
    expect(formatPeriodDate(p.start)).toBe("2026-05-03");
    expect(formatPeriodDate(p.end)).toBe("2026-05-16"); // 14-day inclusive
    expect(formatPeriodDate(p.endExclusive)).toBe("2026-05-17");
  });

  it("the last day of period 0 still resolves to period 0", () => {
    const p = payPeriodForDate(new Date("2026-05-16T23:59:00Z"));
    expect(p.index).toBe(0);
    expect(formatPeriodDate(p.start)).toBe("2026-05-03");
  });

  it("the first day after period 0 rolls to period 1", () => {
    const p = payPeriodForDate(new Date("2026-05-17T00:00:00Z"));
    expect(p.index).toBe(1);
    expect(formatPeriodDate(p.start)).toBe("2026-05-17");
    expect(formatPeriodDate(p.end)).toBe("2026-05-30");
  });

  it("a date before the anchor gets a negative index (cadence extends backward)", () => {
    // 2026-05-02 is the day before the anchor → period -1
    const p = payPeriodForDate(new Date("2026-05-02T08:00:00Z"));
    expect(p.index).toBe(-1);
    expect(formatPeriodDate(p.start)).toBe("2026-04-19");
    expect(formatPeriodDate(p.end)).toBe("2026-05-02");
  });

  it("is DST-stable — a date in a US DST-shift week lands on the right boundary", () => {
    // US DST ended 2026-11-01 (the start of period 13). The period
    // math is UTC-day based, so a date that week resolves
    // deterministically regardless of the clock change.
    const p = payPeriodForDate(new Date("2026-11-08T12:00:00Z"));
    // Period index for 2026-11-08: (days since 05-03) / 14 = 189/14 = 13.5 → floor 13.
    expect(p.index).toBe(13);
    expect(formatPeriodDate(p.start)).toBe("2026-11-01");
    expect(formatPeriodDate(p.end)).toBe("2026-11-14");
  });
});

describe("shiftPayPeriod", () => {
  it("prev/next move by exactly 14 days", () => {
    const base = payPeriodForDate(new Date("2026-05-17T00:00:00Z")); // index 1
    const prev = shiftPayPeriod(base, -1);
    const next = shiftPayPeriod(base, 1);
    expect(prev.index).toBe(0);
    expect(formatPeriodDate(prev.start)).toBe("2026-05-03");
    expect(next.index).toBe(2);
    expect(formatPeriodDate(next.start)).toBe("2026-05-31");
  });
});

describe("recentPayPeriods", () => {
  it("returns N periods newest-first, including the in-progress one", () => {
    const list = recentPayPeriods(new Date("2026-05-20T00:00:00Z"), 3);
    expect(list).toHaveLength(3);
    expect(list[0].index).toBe(1); // 2026-05-20 is in period 1
    expect(list[1].index).toBe(0);
    expect(list[2].index).toBe(-1);
  });
});

describe("payPeriodFromStart", () => {
  it("builds a period from an explicit anchor-aligned start", () => {
    const p = payPeriodFromStart(new Date("2026-05-31T00:00:00Z"));
    expect(p.index).toBe(2);
    expect(formatPeriodDate(p.end)).toBe("2026-06-13");
  });

  it("accepts an off-anchor custom start (operator override) without throwing", () => {
    // 2026-05-30 is NOT an anchor boundary; the helper still produces
    // a 14-day window starting there. index is rounded for display.
    const p = payPeriodFromStart(new Date("2026-05-30T00:00:00Z"));
    expect(formatPeriodDate(p.start)).toBe("2026-05-30");
    expect(formatPeriodDate(p.end)).toBe("2026-06-12");
  });
});

describe("formatPeriodLabel", () => {
  it("renders a readable range", () => {
    const p = payPeriodFromStart(new Date("2026-05-18T00:00:00Z"));
    expect(formatPeriodLabel(p)).toBe("May 18 – May 31, 2026");
  });
});

describe("anchor sanity", () => {
  it("the anchor constant is a Sunday", () => {
    const d = new Date(`${PAY_PERIOD_ANCHOR_ISO}T00:00:00Z`);
    expect(d.getUTCDay()).toBe(0); // Sunday
  });
});
