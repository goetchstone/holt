// /app/__tests__/lib/sales/discountPolicyShared.test.ts
//
// GAP-06: how deep a discount is, measured the same on the screen and the
// server, and what a register PIN may be.

import {
  isApprovalRequired,
  largestDiscountPercent,
  lineDiscountPercent,
  lineSaving,
  pinProblem,
} from "@/lib/sales/discountPolicyShared";
import { hashPin, verifyPassword } from "@/lib/auth/password";

describe("lineDiscountPercent", () => {
  it("is how far below its list a line sells, as a percent of the list", () => {
    expect(lineDiscountPercent({ listUnit: 1000, quantity: 2, netPrice: 1700 })).toBe(15);
  });

  it("is nothing at or above list, or with no list to measure from", () => {
    expect(lineDiscountPercent({ listUnit: 1000, quantity: 1, netPrice: 1000 })).toBe(0);
    expect(lineDiscountPercent({ listUnit: 1000, quantity: 1, netPrice: 1200 })).toBe(0);
    expect(lineDiscountPercent({ listUnit: null, quantity: 1, netPrice: 1 })).toBe(0);
    expect(lineDiscountPercent({ listUnit: 0, quantity: 1, netPrice: 0 })).toBe(0);
  });

  it("is 100 for a line given away, and ignores a sub-cent rounding", () => {
    expect(lineDiscountPercent({ listUnit: 50, quantity: 1, netPrice: 0 })).toBe(100);
    expect(lineDiscountPercent({ listUnit: 33.33, quantity: 3, netPrice: 99.99 })).toBe(0);
  });
});

describe("largestDiscountPercent", () => {
  it("is the deepest line, so a small deep cut can't hide in a big sale", () => {
    expect(
      largestDiscountPercent([
        { listUnit: 5000, quantity: 1, netPrice: 5000 },
        { listUnit: 100, quantity: 1, netPrice: 50 },
      ]),
    ).toBe(50);
    expect(largestDiscountPercent([])).toBe(0);
  });
});

describe("lineSaving", () => {
  it("is the list total less the price, never negative", () => {
    expect(lineSaving({ listUnit: 1000, quantity: 2, netPrice: 1700 })).toBe(300);
    expect(lineSaving({ listUnit: 1000, quantity: 1, netPrice: 1100 })).toBe(0);
    expect(lineSaving({ listUnit: null, quantity: 1, netPrice: 10 })).toBe(0);
  });
});

describe("register PINs", () => {
  it("are 4 to 8 digits", () => {
    expect(pinProblem("1234")).toBeNull();
    expect(pinProblem("12345678")).toBeNull();
    for (const bad of ["123", "123456789", "12a4", " 1234", 1234, null]) {
      expect(pinProblem(bad)).toMatch(/4 to 8 digits/);
    }
  });

  it("are hashed like a password and verified by it", () => {
    const hash = hashPin("2468");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("2468", hash)).toBe(true);
    expect(verifyPassword("2469", hash)).toBe(false);
    expect(() => hashPin("12")).toThrow(/4 to 8 digits/);
  });
});

describe("isApprovalRequired", () => {
  it("recognises the server's ask for a manager, and nothing else", () => {
    expect(
      isApprovalRequired({ error: "x", code: "DISCOUNT_APPROVAL_REQUIRED", percent: 10, limit: 0 }),
    ).toBe(true);
    expect(isApprovalRequired({ error: "Forbidden" })).toBe(false);
    expect(isApprovalRequired(null)).toBe(false);
  });
});
