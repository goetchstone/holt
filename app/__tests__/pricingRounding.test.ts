// /app/__tests__/pricingRounding.test.ts
//
// How a computed retail is rounded (GAP-06, lib/pricing/rounding.ts): in whole
// cents, half up, never below zero.

import { RETAIL_ROUNDINGS, roundRetail, toCents } from "@/lib/pricing/rounding";

describe("toCents", () => {
  it("rounds half a cent up, from the number's decimal text rather than float multiplication", () => {
    // 1.005 * 100 is 100.49999... in floating point; Math.round would say 100.
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(toCents(1.005)).toBe(101);
    expect(toCents(0.995)).toBe(100);
    expect(toCents(0.994)).toBe(99);
    expect(toCents(102.2)).toBe(10220);
    expect(toCents(0)).toBe(0);
  });

  it("refuses a negative or non-finite price", () => {
    expect(() => toCents(-0.01)).toThrow(RangeError);
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
    expect(() => toCents(Infinity)).toThrow(RangeError);
  });
});

describe("roundRetail", () => {
  it("CENTS invents nothing beyond the cent", () => {
    expect(roundRetail(220.004, "CENTS")).toBe(220);
    expect(roundRetail(0.995, "CENTS")).toBe(1);
    expect(roundRetail(102.2, "CENTS")).toBe(102.2);
  });

  it("WHOLE_UP goes to the next dollar, and leaves a whole dollar alone", () => {
    expect(roundRetail(102.01, "WHOLE_UP")).toBe(103);
    expect(roundRetail(103, "WHOLE_UP")).toBe(103);
    expect(roundRetail(0.995, "WHOLE_UP")).toBe(1);
  });

  it("WHOLE_NEAREST goes to the nearer dollar, half up", () => {
    expect(roundRetail(102.49, "WHOLE_NEAREST")).toBe(102);
    expect(roundRetail(102.5, "WHOLE_NEAREST")).toBe(103);
    expect(roundRetail(102.495, "WHOLE_NEAREST")).toBe(103); // 102.50 to the cent first
  });

  it("END_99 is just under the nearest whole dollar, so the left digit drops", () => {
    expect(roundRetail(100, "END_99")).toBe(99.99);
    expect(roundRetail(101.4, "END_99")).toBe(100.99);
    expect(roundRetail(101.6, "END_99")).toBe(101.99);
    expect(roundRetail(99.99, "END_99")).toBe(99.99);
    expect(roundRetail(100.495, "END_99")).toBe(100.99); // 100.50 to the cent first, so 101 less a cent
    expect(roundRetail(0.6, "END_99")).toBe(0.99);
  });

  it("END_95 is five cents under the nearest whole dollar", () => {
    expect(roundRetail(100, "END_95")).toBe(99.95);
    expect(roundRetail(102.2, "END_95")).toBe(101.95);
    expect(roundRetail(102.96, "END_95")).toBe(102.95);
  });

  it("END_99 / END_95 leave a price that rounds to no dollar at $0, never negative", () => {
    expect(roundRetail(0.4, "END_99")).toBe(0);
    expect(roundRetail(0.4, "END_95")).toBe(0);
  });

  it("only the up rule never lands below the price worked out", () => {
    for (const value of [0.01, 1.5, 99.99, 100, 1234.56]) {
      expect(roundRetail(value, "WHOLE_UP")).toBeGreaterThanOrEqual(value);
    }
  });

  it("keeps zero at zero and refuses a negative price", () => {
    for (const rule of RETAIL_ROUNDINGS) expect(roundRetail(0, rule)).toBe(0);
    expect(() => roundRetail(-5, "END_99")).toThrow(RangeError);
  });
});
