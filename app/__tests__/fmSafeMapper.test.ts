// /app/__tests__/fmSafeMapper.test.ts

import { safeString, safeFloat, safeDate } from "../src/lib/fmSafeMapper";

// ─── safeString ─────────────────────────────────────────────────────

describe("safeString", () => {
  it("returns empty string for null", () => {
    expect(safeString(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(safeString(undefined)).toBe("");
  });

  it("trims whitespace", () => {
    expect(safeString("  hello  ")).toBe("hello");
  });

  it("converts numbers to string", () => {
    expect(safeString(42)).toBe("42");
  });

  it("returns empty string for empty input", () => {
    expect(safeString("")).toBe("");
  });

  it("returns empty string for zero (falsy)", () => {
    // safeString uses (str || "") which coerces 0 to empty string
    expect(safeString(0)).toBe("");
  });
});

// ─── safeFloat ──────────────────────────────────────────────────────

describe("safeFloat", () => {
  it("returns 0 for null", () => {
    expect(safeFloat(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(safeFloat(undefined)).toBe(0);
  });

  it("parses plain number string", () => {
    expect(safeFloat("123.45")).toBe(123.45);
  });

  it("strips dollar signs and commas", () => {
    expect(safeFloat("$1,299.99")).toBe(1299.99);
  });

  it("strips other non-numeric characters", () => {
    expect(safeFloat("approx 500")).toBe(500);
  });

  it("returns 0 for non-numeric content", () => {
    expect(safeFloat("no numbers here")).toBe(0);
  });

  it("handles negative values", () => {
    expect(safeFloat("-50.25")).toBe(-50.25);
  });
});

// ─── safeDate ───────────────────────────────────────────────────────

describe("safeDate", () => {
  it("returns null for null", () => {
    expect(safeDate(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeDate("")).toBeNull();
  });

  it("parses MM/DD/YYYY format", () => {
    const d = safeDate("03/15/2026");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(2); // March
    expect(d!.getDate()).toBe(15);
  });

  it("returns null for invalid date parts", () => {
    expect(safeDate("not/a/date")).toBeNull();
  });

  it("returns null for missing parts", () => {
    expect(safeDate("03/15")).toBeNull();
  });

  it("returns null for zero month", () => {
    expect(safeDate("0/15/2026")).toBeNull();
  });
});
