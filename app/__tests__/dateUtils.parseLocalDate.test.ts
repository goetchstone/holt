// /app/__tests__/dateUtils.parseLocalDate.test.ts
//
// Tripwire for the "drilldown shows date one day earlier than the user
// expects" bug class. Every SalesOrder.orderDate in production is stored as
// midnight UTC (`2026-04-22T00:00:00.000Z`). When the UI renders
// `new Date(orderDate).toLocaleDateString()` in US Eastern (UTC-4 / UTC-5),
// the displayed date shifts BACK one calendar day relative to what the
// filter and the database row actually represent.
//
// Same bug shape as the 2026-04-14 daysBetween fix in the failure log.
//
// `parseLocalDate` strips the time portion of the ISO string and parses just
// the YYYY-MM-DD as a local-timezone Date. Result: the displayed calendar
// day matches the stored calendar day regardless of the browser's timezone.
//
// History: shipped via `fix/detailed-sales-drilldown-utc-date-display`
// after a user report on 2026-04-29 ("incorrect dates and different
// orders" on the Detailed Sales drilldown).

import { parseLocalDate } from "@/lib/dateUtils";

describe("parseLocalDate", () => {
  it("preserves the calendar date for a UTC-midnight ISO string", () => {
    const stored = "2026-04-22T00:00:00.000Z";
    const parsed = parseLocalDate(stored);
    // The displayed calendar parts must match the stored calendar parts,
    // not be shifted by the timezone offset. Use UTC-agnostic getters
    // (the function returns a Date built from local Y/M/D, which is what
    // `toLocaleDateString` then formats correctly in any timezone).
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3); // April (0-indexed)
    expect(parsed.getDate()).toBe(22);
  });

  it("formats to the same calendar day as the YYYY-MM-DD prefix in any local timezone", () => {
    // The function's contract: in whatever timezone the runtime is in,
    // formatting the returned Date via local .toLocaleDateString() produces
    // a calendar day that matches the YYYY-MM-DD prefix. This is the
    // shipped usage pattern (`parseLocalDate(iso).toLocaleDateString()`
    // with no timezone override) and must hold equally in EDT (Mac dev
    // box default), UTC (CI runner default), or any other browser TZ.
    //
    // Without parseLocalDate, `new Date("2026-04-22T00:00:00.000Z").toLocaleDateString()`
    // prints "4/21/2026" in EDT browsers (UTC midnight = 8 PM prior day in EDT)
    // and "4/22/2026" in UTC environments. With parseLocalDate, both print
    // "4/22/2026" because we reconstruct the date as local-Y/M/D, decoupling
    // from the wall-clock instant the original UTC string represented.
    const stored = "2026-04-22T00:00:00.000Z";
    const formatted = parseLocalDate(stored).toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    expect(formatted).toBe("4/22/2026");
  });

  it("handles a non-midnight ISO by still extracting the YYYY-MM-DD prefix", () => {
    // Defensive: if a future API ever returns a real timestamp, we still
    // parse the date portion only -- no time-of-day component is honored.
    const stored = "2026-04-22T18:30:00.000Z";
    const parsed = parseLocalDate(stored);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3);
    expect(parsed.getDate()).toBe(22);
  });

  it("accepts a Date input by formatting it through toISOString first", () => {
    // Edge case: caller passes a Date instead of a string. The function
    // must still produce a stable local-Y/M/D result.
    const stored = new Date("2026-04-22T00:00:00.000Z");
    const parsed = parseLocalDate(stored);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(3);
    expect(parsed.getDate()).toBe(22);
  });

  it("handles year-boundary dates (Jan 1) without rolling back to Dec 31", () => {
    // The classic UTC-midnight bug: a "January 1" order would display as
    // "December 31 prior year" in EST. Tripwire ensures it stays Jan 1.
    const stored = "2026-01-01T00:00:00.000Z";
    const parsed = parseLocalDate(stored);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(0); // January
    expect(parsed.getDate()).toBe(1);
  });

  it("handles month-boundary dates without rolling back to prior month", () => {
    const stored = "2026-05-01T00:00:00.000Z";
    const parsed = parseLocalDate(stored);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(4); // May
    expect(parsed.getDate()).toBe(1);
  });
});
