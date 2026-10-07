// /app/__tests__/weekOverWeek.test.ts
//
// Pure tests for the Weekly Summary week-over-week date math.
// Weeks are Sunday-aligned; "same week last year" is 52 weeks back.

import {
  startOfRetailWeek,
  lastCompleteWeekStart,
  weekEnd,
  weekEndExclusive,
  sameWeekLastYear,
  formatWeekRange,
  formatYmd,
} from "../src/lib/weekOverWeek";

describe("startOfRetailWeek", () => {
  it("snaps a midweek date back to its Sunday", () => {
    // Fri 2026-05-29 → Sun 2026-05-24
    expect(formatYmd(startOfRetailWeek(new Date("2026-05-29T15:00:00Z")))).toBe("2026-05-24");
  });

  it("leaves a Sunday unchanged", () => {
    expect(formatYmd(startOfRetailWeek(new Date("2026-05-17T00:00:00Z")))).toBe("2026-05-17");
  });

  it("crosses the year boundary correctly", () => {
    // Sat 2026-01-03 → Sun 2025-12-28
    expect(formatYmd(startOfRetailWeek(new Date("2026-01-03T00:00:00Z")))).toBe("2025-12-28");
  });

  it("always returns a Sunday (UTC day 0)", () => {
    for (const d of ["2026-05-29", "2026-02-14", "2026-12-31", "2025-07-04"]) {
      expect(startOfRetailWeek(new Date(`${d}T12:00:00Z`)).getUTCDay()).toBe(0);
    }
  });
});

describe("lastCompleteWeekStart", () => {
  it("returns the Sunday that began the week before the current one", () => {
    // Today Fri 2026-05-29 → current week starts 05-24 → last complete week 05-17
    const lw = lastCompleteWeekStart(new Date("2026-05-29T15:00:00Z"));
    expect(formatYmd(lw)).toBe("2026-05-17");
    expect(lw.getUTCDay()).toBe(0);
  });
});

describe("week bounds", () => {
  it("weekEnd is the inclusive Saturday; weekEndExclusive is the next Sunday", () => {
    const ws = new Date("2026-05-17T00:00:00Z");
    expect(formatYmd(weekEnd(ws))).toBe("2026-05-23");
    expect(formatYmd(weekEndExclusive(ws))).toBe("2026-05-24");
  });
});

describe("sameWeekLastYear", () => {
  it("is 52 weeks (364 days) back and keeps the weekday aligned", () => {
    const ws = new Date("2026-05-17T00:00:00Z"); // Sunday
    const ly = sameWeekLastYear(ws);
    expect(formatYmd(ly)).toBe("2025-05-18");
    expect(ly.getUTCDay()).toBe(0); // still a Sunday
  });
});

describe("formatWeekRange", () => {
  it("renders the inclusive week range", () => {
    expect(formatWeekRange(new Date("2026-05-17T00:00:00Z"))).toBe("May 17 – May 23, 2026");
    expect(formatWeekRange(new Date("2025-05-18T00:00:00Z"))).toBe("May 18 – May 24, 2025");
  });
});
