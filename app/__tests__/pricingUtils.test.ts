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
});
