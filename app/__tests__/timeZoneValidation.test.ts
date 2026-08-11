// /app/__tests__/timeZoneValidation.test.ts
//
// AppSettings.timezone decides which business day a sale, a journal entry and
// the daily reconciliation each belong to. Until this guard existed the admin
// form was free text validated only as "non-empty", so "Eastern" saved happily
// and then threw a RangeError inside Intl.DateTimeFormat -- breaking
// salesDaily, generateSalesJournal and computeDailyReconciliation together,
// from one typo.
//
// The pairing that matters: the WRITE path rejects (so an operator is told
// immediately) and the READ path falls back (so an already-bad row, or one
// written before this guard, does not keep every report broken).

import { isValidTimeZone, businessDayKey, businessDayRange } from "@/lib/reports/businessDay";

describe("isValidTimeZone", () => {
  it.each([
    "UTC",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Pacific/Auckland",
    "Etc/UTC",
  ])("accepts %s", (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each([
    ["Eastern", "a colloquial name, not an IANA zone"],
    ["America/Nowhere", "well-formed but not a real zone"],
    ["", "empty"],
    ["   ", "whitespace only"],
    ["America/New_York ", "trailing space — Intl does not trim, so callers must"],
    ["  UTC", "leading space"],
  ])("rejects %j (%s)", (tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });

  // Intl is looser than an IANA-only reading suggests, and the guard inherits
  // that deliberately rather than being stricter than the code it protects.
  it.each(["utc", "america/new_york", "EST", "GMT", "US/Eastern"])(
    "accepts %j — case-insensitive matching and legacy aliases both resolve",
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(true);
    },
  );

  it("accepts every value it accepts without the date helpers throwing", () => {
    // The property the probe actually promises: anything it approves is safe to
    // hand to the helpers. A membership test against Intl.supportedValuesOf
    // would NOT give this — it omits "UTC".
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Etc/UTC"]) {
      expect(isValidTimeZone(tz)).toBe(true);
      expect(() => businessDayKey(new Date("2026-06-09T12:00:00Z"), tz)).not.toThrow();
      expect(() => businessDayRange("2026-06-09", tz)).not.toThrow();
    }
  });

  it("is exactly the set the date helpers can format with", () => {
    // Both directions: a rejected zone really does throw, so the guard is not
    // merely conservative — it is the actual boundary.
    for (const tz of ["Eastern", "America/Nowhere", "America/New_York "]) {
      expect(isValidTimeZone(tz)).toBe(false);
      expect(() => businessDayKey(new Date(0), tz)).toThrow(RangeError);
    }
  });

  it("does not rely on Intl.supportedValuesOf, which omits UTC", () => {
    // Pins the reason for the try/catch implementation. If someone "simplifies"
    // this to an allow-list, UTC stops being selectable and this fails.
    const supported =
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    expect(supported).not.toContain("UTC");
    expect(isValidTimeZone("UTC")).toBe(true);
  });
});
