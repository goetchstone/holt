// /app/__tests__/designerDashboardDates.test.ts
//
// Validates the date range logic for the designer dashboard to prevent
// regressions where prior-year YTD includes the full prior year instead of
// only through the equivalent calendar day. getDateRanges is the shared period
// math (lib/reports/dateRanges.ts) used by the designer-dashboard report lib
// after the App Router + tRPC port.

import { getDateRanges } from "@/lib/reports/dateRanges";

describe("getDateRanges", () => {
  it("computes correct bounds for a mid-year date", () => {
    const r = getDateRanges("2026-03-24");

    expect(r.currentYear).toBe(2026);
    expect(r.prevYear).toBe(2025);

    // MTD: March 1 through end of March 24
    expect(r.mtd.start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(r.mtd.end.toISOString()).toBe("2026-03-25T00:00:00.000Z");

    // YTD: Jan 1 through end of March 24
    expect(r.ytd.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(r.ytd.end.toISOString()).toBe("2026-03-25T00:00:00.000Z");

    // Prior MTD: March 1-24, 2025
    expect(r.prevMtd.start.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(r.prevMtd.end.toISOString()).toBe("2025-03-25T00:00:00.000Z");

    // Prior YTD: Jan 1 - March 24, 2025 (NOT Dec 31)
    expect(r.prevYtd.start.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(r.prevYtd.end.toISOString()).toBe("2025-03-25T00:00:00.000Z");
  });

  it("prior YTD end never reaches December of the prior year", () => {
    // Test several dates throughout the year to ensure prevYtd.end stays
    // within the same month/day range as the reference date.
    const dates = ["2026-01-15", "2026-06-30", "2026-09-01", "2026-11-30", "2026-12-31"];

    for (const d of dates) {
      const r = getDateRanges(d);
      const ref = new Date(d);
      const refMonth = ref.getUTCMonth();
      const refDay = ref.getUTCDate();

      // prevYtd.end should be the day after (refMonth, refDay) in prevYear
      const expectedEnd = new Date(Date.UTC(r.prevYear, refMonth, refDay + 1));
      expect(r.prevYtd.end.toISOString()).toBe(expectedEnd.toISOString());

      // prevYtd.end must always be before or equal to the same calendar date + 1 day
      // in the prior year. It must never be Dec 31 unless the reference date IS Dec 31.
      if (refMonth < 11 || refDay < 31) {
        const dec31 = new Date(Date.UTC(r.prevYear, 11, 31));
        expect(r.prevYtd.end.getTime()).toBeLessThan(dec31.getTime());
      }
    }
  });

  it("Jan 1 yields identical MTD and YTD ranges", () => {
    const r = getDateRanges("2026-01-01");

    expect(r.mtd.start.toISOString()).toBe(r.ytd.start.toISOString());
    expect(r.mtd.end.toISOString()).toBe(r.ytd.end.toISOString());

    expect(r.prevMtd.start.toISOString()).toBe(r.prevYtd.start.toISOString());
    expect(r.prevMtd.end.toISOString()).toBe(r.prevYtd.end.toISOString());
  });

  it("uses exclusive upper bounds (start of next day)", () => {
    const r = getDateRanges("2026-07-15");

    // End dates should be midnight of the NEXT day, not 23:59:59.999
    expect(r.mtd.end.getUTCHours()).toBe(0);
    expect(r.mtd.end.getUTCMinutes()).toBe(0);
    expect(r.mtd.end.getUTCSeconds()).toBe(0);
    expect(r.mtd.end.getUTCMilliseconds()).toBe(0);

    expect(r.ytd.end.getUTCHours()).toBe(0);
    expect(r.prevYtd.end.getUTCHours()).toBe(0);
  });

  it("handles month-end boundary correctly", () => {
    // March 31 -- prior year March also has 31 days
    const r = getDateRanges("2026-03-31");
    expect(r.prevYtd.end.toISOString()).toBe("2025-04-01T00:00:00.000Z");

    // Feb 28 in a non-leap year
    const r2 = getDateRanges("2027-02-28");
    expect(r2.prevYtd.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});
