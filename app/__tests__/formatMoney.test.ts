// /app/__tests__/formatMoney.test.ts

import { formatMoney, formatDate, formatDateTime, DEFAULT_LOCALE_CONFIG } from "@/lib/formatMoney";

describe("formatMoney", () => {
  test("defaults to USD / en-US", () => {
    expect(formatMoney(1234.5)).toBe("$1,234.50");
  });

  test("respects a different currency + locale", () => {
    // EUR in de-DE uses comma decimal + trailing symbol.
    const out = formatMoney(1234.5, { locale: "de-DE", currency: "EUR" });
    expect(out).toContain("€");
    expect(out).toContain("1.234,50");
  });

  test("whole option drops the cents", () => {
    expect(formatMoney(1234.5, { whole: true })).toBe("$1,235");
  });

  test("coerces null/undefined/NaN to zero", () => {
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(undefined)).toBe("$0.00");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });

  test("falls back to default config on an invalid currency code", () => {
    expect(formatMoney(10, { currency: "NOTACURRENCY" })).toBe("$10.00");
  });

  test("GBP renders the pound symbol", () => {
    expect(formatMoney(99.99, { locale: "en-GB", currency: "GBP" })).toBe("£99.99");
  });
});

describe("formatDate", () => {
  test("formats an ISO date in the default locale/timezone", () => {
    // Noon UTC is the same calendar day in America/New_York, so no drift.
    expect(formatDate("2026-05-30T12:00:00.000Z")).toBe("May 30, 2026");
  });

  test("returns empty string for null/undefined/empty/invalid", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("not-a-date")).toBe("");
  });

  test("respects a short date style", () => {
    // en-US short = M/D/YYYY
    expect(formatDate("2026-05-30T12:00:00.000Z", { dateStyle: "short" })).toBe("5/30/26");
  });
});

describe("formatDateTime", () => {
  test("returns empty string for invalid input", () => {
    expect(formatDateTime(null)).toBe("");
    expect(formatDateTime("nope")).toBe("");
  });

  test("includes both date and time for a valid value", () => {
    const out = formatDateTime("2026-05-30T16:30:00.000Z", { timezone: "America/New_York" });
    expect(out).toContain("2026");
    // 16:30 UTC = 12:30 PM EDT
    expect(out).toMatch(/12:30/);
  });
});

describe("DEFAULT_LOCALE_CONFIG", () => {
  test("is USD / en-US / America/New_York", () => {
    expect(DEFAULT_LOCALE_CONFIG).toEqual({
      locale: "en-US",
      currency: "USD",
      timezone: "America/New_York",
    });
  });
});
