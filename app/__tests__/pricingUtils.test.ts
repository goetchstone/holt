// /app/__tests__/pricingUtils.test.ts

import { parseCurrency } from "../src/lib/pricing/pricingUtils";

describe("parseCurrency", () => {
  it("parses plain number", () => {
    expect(parseCurrency("1350")).toBe(1350);
  });

  it("parses number with dollar sign", () => {
    expect(parseCurrency("$1,350")).toBe(1350);
  });

  it("parses number with dollar sign and cents", () => {
    expect(parseCurrency("$1,299.99")).toBe(1299.99);
  });

  it("strips spaces", () => {
    expect(parseCurrency(" 500 ")).toBe(500);
  });

  it("returns NaN for N/A", () => {
    expect(parseCurrency("N/A")).toBeNaN();
  });

  it("returns NaN for N/C", () => {
    expect(parseCurrency("N/C")).toBeNaN();
  });

  it("returns NaN for dash", () => {
    expect(parseCurrency("-")).toBeNaN();
  });

  it("returns NaN for empty string", () => {
    expect(parseCurrency("")).toBeNaN();
  });

  it("handles decimal without leading zero", () => {
    expect(parseCurrency(".99")).toBe(0.99);
  });

  it("handles multiple commas", () => {
    expect(parseCurrency("$1,234,567")).toBe(1234567);
  });

  // An overflowing price takes the same "no price in this cell" path as N/A, so
  // every caller's isNaN skip covers it; Infinity passed `isNaN` and `cost > 0`.
  it.each([
    ["a 400-digit run", "9".repeat(400)],
    ["a 400-digit dollar amount", `$${"9".repeat(400)}.00`],
    ["1e999", "1e999"],
    ["Infinity", "Infinity"],
  ])("returns NaN for %s, which is not a real price", (_label, raw) => {
    expect(parseCurrency(raw)).toBeNaN();
  });
});
