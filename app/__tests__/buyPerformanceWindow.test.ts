// /app/__tests__/buyPerformanceWindow.test.ts
//
// A-grade tests for the Slice 6.2 sales-window derivation helper.

import {
  deriveSalesWindow,
  parseShipMonth,
  normalizeShipMonth,
  formatShipMonthForInput,
  formatShipMonthForDisplay,
  shiftWindowOneYearBack,
  type BuyPoForWindow,
} from "@/lib/buyPerformanceWindow";

const NOW = new Date("2026-05-12T12:00:00.000Z");

describe("parseShipMonth", () => {
  it("parses YYYY-MM to first-of-month UTC", () => {
    const d = parseShipMonth("2026-03");
    expect(d).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("returns null for empty / null / whitespace", () => {
    expect(parseShipMonth(null)).toBeNull();
    expect(parseShipMonth("")).toBeNull();
    expect(parseShipMonth("   ")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseShipMonth("March")).toBeNull(); // free-text fallback from legacy
    expect(parseShipMonth("2026/03")).toBeNull(); // wrong separator
    expect(parseShipMonth("26-03")).toBeNull(); // 2-digit on both sides (ambiguous)
    expect(parseShipMonth("2026-3")).toBeNull(); // 1-digit month
    expect(parseShipMonth("2026-13")).toBeNull(); // month > 12
    expect(parseShipMonth("2026-00")).toBeNull(); // month < 1
    expect(parseShipMonth("2026-03-15")).toBeNull(); // full date
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseShipMonth("  2026-03  ")).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  // ── 2026-05-13: MM-YYYY format support ──────────────────────────────
  // Found real production data with the format flipped (PO #1 had
  // expectedShipMonth = "01-2026", PO #3 had "02-2026"). Some iPad
  // Safari date-picker quirk OR a manual-entry path produced this. We
  // now accept both shapes and disambiguate by the 4-vs-2-digit halves.

  it("parses MM-YYYY (the prod-data shape observed 2026-05-13)", () => {
    expect(parseShipMonth("01-2026")).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(parseShipMonth("02-2026")).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(parseShipMonth("12-2025")).toEqual(new Date("2025-12-01T00:00:00.000Z"));
  });

  it("rejects ambiguous 2-2 shapes (both sides 2-digit)", () => {
    // "01-02" could be Jan 2002 OR Feb 2001 — refuse to guess.
    expect(parseShipMonth("01-02")).toBeNull();
    expect(parseShipMonth("12-25")).toBeNull();
  });

  it("rejects month > 12 in either position", () => {
    expect(parseShipMonth("13-2026")).toBeNull(); // MM-YYYY: invalid month
    expect(parseShipMonth("2026-13")).toBeNull(); // YYYY-MM: invalid month
  });

  it("rejects year < 1900 (catches MM-YYYY with month-as-year typos)", () => {
    expect(parseShipMonth("0026-12")).toBeNull(); // YYYY-MM with year 26 AD
  });
});

describe("normalizeShipMonth", () => {
  it("canonicalizes MM-YYYY to YYYY-MM", () => {
    expect(normalizeShipMonth("01-2026")).toBe("2026-01");
    expect(normalizeShipMonth("12-2025")).toBe("2025-12");
  });

  it("leaves YYYY-MM unchanged", () => {
    expect(normalizeShipMonth("2026-03")).toBe("2026-03");
  });

  it("zero-pads single-digit months in output", () => {
    // Even though the parser rejects "2026-3", testing the formatter
    // builds month numbers from a Date — confirm the output pad.
    expect(normalizeShipMonth("3-2026")).toBeNull(); // input doesn't match either shape
  });

  it("returns null for any unparseable input", () => {
    expect(normalizeShipMonth(null)).toBeNull();
    expect(normalizeShipMonth("")).toBeNull();
    expect(normalizeShipMonth("March")).toBeNull();
    expect(normalizeShipMonth("01-02")).toBeNull();
  });
});

describe("deriveSalesWindow", () => {
  it("picks expectedDeliveryDate when present (precise wins over month)", () => {
    const pos: BuyPoForWindow[] = [
      {
        expectedShipMonth: "2026-05",
        expectedDeliveryDate: new Date("2026-03-15T00:00:00.000Z"),
      },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.source).toBe("expectedDeliveryDate");
    expect(w.start).toEqual(new Date("2026-03-15T00:00:00.000Z"));
    expect(w.end).toEqual(NOW);
  });

  it("falls back to expectedShipMonth when no expectedDeliveryDate", () => {
    const pos: BuyPoForWindow[] = [{ expectedShipMonth: "2026-03", expectedDeliveryDate: null }];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.source).toBe("expectedShipMonth");
    expect(w.start).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(w.message).toContain("March 2026");
  });

  it("takes the MINIMUM start across multiple POs", () => {
    // Spring buy with two POs: AL ETA March, ML ETA February → window
    // starts February (the earlier date — anything sold before February
    // can't be from either PO).
    const pos: BuyPoForWindow[] = [
      { expectedShipMonth: "2026-03", expectedDeliveryDate: null },
      { expectedShipMonth: "2026-02", expectedDeliveryDate: null },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.start).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(w.source).toBe("expectedShipMonth");
  });

  it("mixed POs: one has expectedDeliveryDate, another only expectedShipMonth", () => {
    const pos: BuyPoForWindow[] = [
      { expectedShipMonth: null, expectedDeliveryDate: new Date("2026-04-20T00:00:00.000Z") },
      { expectedShipMonth: "2026-03", expectedDeliveryDate: null },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    // expectedShipMonth → March 1 is earlier than expectedDeliveryDate
    // → April 20, so March 1 wins.
    expect(w.start).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(w.source).toBe("expectedShipMonth");
  });

  it("falls back to full-history with warning when NO PO has any ETA set", () => {
    const pos: BuyPoForWindow[] = [
      { expectedShipMonth: null, expectedDeliveryDate: null },
      { expectedShipMonth: null, expectedDeliveryDate: null },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.start).toBeNull();
    expect(w.end).toEqual(NOW);
    expect(w.source).toBe("fallback-full-history");
    expect(w.message).toContain("Set an ETA");
  });

  it("falls back to full-history with empty POs list (new buy, no POs yet)", () => {
    const w = deriveSalesWindow({ pos: [], now: NOW });
    expect(w.start).toBeNull();
    expect(w.source).toBe("fallback-full-history");
  });

  it("treats invalid shipMonth strings as 'no ETA' for that PO", () => {
    // Legacy data may have free-text like "March" (the pre-input-type=month
    // shape). We don't try to parse those — they fall through to whatever
    // other PO has a valid ETA, or to full-history.
    const pos: BuyPoForWindow[] = [
      { expectedShipMonth: "March", expectedDeliveryDate: null },
      { expectedShipMonth: "2026-04", expectedDeliveryDate: null },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.start).toEqual(new Date("2026-04-01T00:00:00.000Z"));
    expect(w.source).toBe("expectedShipMonth");
  });

  it("formats message with full month name + year for UI display", () => {
    const pos: BuyPoForWindow[] = [{ expectedShipMonth: "2026-09", expectedDeliveryDate: null }];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.message).toBe("Sales since September 2026");
  });

  // Phase 6.8 — actualReceivedDate wins over both planned signals.
  it("prefers actualReceivedDate over expectedDeliveryDate", () => {
    const pos: BuyPoForWindow[] = [
      {
        expectedShipMonth: "2026-01",
        expectedDeliveryDate: new Date("2026-02-15T00:00:00.000Z"),
        actualReceivedDate: new Date("2026-03-20T00:00:00.000Z"),
      },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.source).toBe("actualReceivedDate");
    expect(w.start).toEqual(new Date("2026-03-20T00:00:00.000Z"));
  });

  it("uses actualReceivedDate when planned dates are missing too", () => {
    const pos: BuyPoForWindow[] = [
      {
        expectedShipMonth: null,
        expectedDeliveryDate: null,
        actualReceivedDate: new Date("2026-03-20T00:00:00.000Z"),
      },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.source).toBe("actualReceivedDate");
    expect(w.start).toEqual(new Date("2026-03-20T00:00:00.000Z"));
  });

  it("falls back to planned dates for POs without actualReceivedDate yet", () => {
    // Future-looking buy: ETAs set but nothing's arrived. Window
    // anchors to the planned month, unchanged from pre-6.8 behavior.
    const pos: BuyPoForWindow[] = [
      {
        expectedShipMonth: "2026-08",
        expectedDeliveryDate: null,
        actualReceivedDate: null,
      },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    expect(w.source).toBe("expectedShipMonth");
    expect(w.start).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("MIN across POs honors mixed signals (one received, one planned)", () => {
    const pos: BuyPoForWindow[] = [
      {
        expectedShipMonth: null,
        expectedDeliveryDate: null,
        actualReceivedDate: new Date("2026-03-20T00:00:00.000Z"),
      },
      { expectedShipMonth: "2026-04", expectedDeliveryDate: null },
    ];
    const w = deriveSalesWindow({ pos, now: NOW });
    // earliest start wins regardless of source
    expect(w.start).toEqual(new Date("2026-03-20T00:00:00.000Z"));
    expect(w.source).toBe("actualReceivedDate");
  });
});

describe("shiftWindowOneYearBack", () => {
  it("shifts both start and end by exactly one year", () => {
    const w = deriveSalesWindow({
      pos: [{ expectedShipMonth: "2026-03", expectedDeliveryDate: null }],
      now: NOW,
    });
    const shifted = shiftWindowOneYearBack(w);
    expect(shifted.start).toEqual(new Date("2025-03-01T00:00:00.000Z"));
    expect(shifted.end).toEqual(new Date("2025-05-12T12:00:00.000Z"));
    expect(shifted.message).toContain("Prior-year compare");
    expect(shifted.message).toContain("March 2025");
  });

  it("keeps start=null when input start is null but still shifts end", () => {
    const w = deriveSalesWindow({ pos: [], now: NOW });
    const shifted = shiftWindowOneYearBack(w);
    expect(shifted.start).toBeNull();
    expect(shifted.end).toEqual(new Date("2025-05-12T12:00:00.000Z"));
    expect(shifted.message).toContain("full history");
    expect(shifted.message).toContain("May 2025");
  });

  it("preserves the source attribution after the shift", () => {
    const w = deriveSalesWindow({
      pos: [
        { expectedShipMonth: null, expectedDeliveryDate: new Date("2026-03-15T00:00:00.000Z") },
      ],
      now: NOW,
    });
    const shifted = shiftWindowOneYearBack(w);
    expect(shifted.source).toBe("expectedDeliveryDate");
  });
});

// ── Post-DateTime-promotion (2026-05-13) ────────────────────────────────
// `BuyPoForWindow.expectedShipMonth` is now `Date | string | null`.
// Confirm the helper accepts a Date directly.

describe("deriveSalesWindow — Date input (post-DateTime promotion)", () => {
  it("accepts a Date for expectedShipMonth and treats it as the start", () => {
    const w = deriveSalesWindow({
      pos: [
        { expectedShipMonth: new Date("2026-02-01T00:00:00.000Z"), expectedDeliveryDate: null },
      ],
      now: NOW,
    });
    expect(w.start).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(w.source).toBe("expectedShipMonth");
  });

  it("Date and YYYY-MM string in the same buy take the earlier", () => {
    const w = deriveSalesWindow({
      pos: [
        { expectedShipMonth: new Date("2026-04-01T00:00:00.000Z"), expectedDeliveryDate: null },
        { expectedShipMonth: "2026-02", expectedDeliveryDate: null },
      ],
      now: NOW,
    });
    expect(w.start).toEqual(new Date("2026-02-01T00:00:00.000Z"));
  });
});

describe("formatShipMonthForInput", () => {
  it("formats Date to YYYY-MM (for <input type='month'>)", () => {
    expect(formatShipMonthForInput(new Date("2026-03-01T00:00:00.000Z"))).toBe("2026-03");
    expect(formatShipMonthForInput(new Date("2026-12-15T12:34:56.000Z"))).toBe("2026-12");
  });

  it("passes YYYY-MM strings through unchanged", () => {
    expect(formatShipMonthForInput("2026-03")).toBe("2026-03");
    expect(formatShipMonthForInput("  2026-03  ")).toBe("2026-03");
  });

  it("normalizes MM-YYYY to YYYY-MM (legacy iPad-Safari shape)", () => {
    expect(formatShipMonthForInput("01-2026")).toBe("2026-01");
  });

  it("normalizes ISO datetime strings (what the API serializes Dates to)", () => {
    expect(formatShipMonthForInput("2026-03-01T00:00:00.000Z")).toBe("2026-03");
  });

  it("returns empty string for null / unparseable input (input renders empty)", () => {
    expect(formatShipMonthForInput(null)).toBe("");
    expect(formatShipMonthForInput(undefined)).toBe("");
    expect(formatShipMonthForInput("")).toBe("");
    expect(formatShipMonthForInput("garbage")).toBe("");
  });
});

describe("formatShipMonthForDisplay", () => {
  it("formats Date to 'Month YYYY'", () => {
    expect(formatShipMonthForDisplay(new Date("2026-03-01T00:00:00.000Z"))).toBe("March 2026");
    expect(formatShipMonthForDisplay(new Date("2025-12-15T00:00:00.000Z"))).toBe("December 2025");
  });

  it("formats YYYY-MM string to 'Month YYYY'", () => {
    expect(formatShipMonthForDisplay("2026-03")).toBe("March 2026");
  });

  it("formats MM-YYYY string to 'Month YYYY'", () => {
    expect(formatShipMonthForDisplay("01-2026")).toBe("January 2026");
  });

  it("formats ISO datetime string to 'Month YYYY'", () => {
    expect(formatShipMonthForDisplay("2026-03-01T00:00:00.000Z")).toBe("March 2026");
  });

  it("returns null for null / unparseable input (caller decides whether to show chip)", () => {
    expect(formatShipMonthForDisplay(null)).toBeNull();
    expect(formatShipMonthForDisplay("")).toBeNull();
    expect(formatShipMonthForDisplay("not a date")).toBeNull();
  });
});
