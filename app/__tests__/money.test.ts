// /app/__tests__/money.test.ts
//
// PLACEHOLDER TEST — Grade: A (Decimal mock only; no SQL exercised).
// The jest.mock("@prisma/client") below substitutes a stub Decimal
// class so the test can run without loading the full Prisma engine.
// The test itself exercises pure money/decimal arithmetic — no Prisma
// query, no DB. NOT a placeholder for a real-DB test; the mock is
// purely an isolation shim.

// Mock the Prisma Decimal so tests run without the full Prisma client.
// Prisma 7 exposes Decimal via the Prisma namespace on @prisma/client.
jest.mock("@prisma/client", () => ({
  Prisma: {
    Decimal: class MockDecimal {
      private value: string;
      constructor(val: string | number) {
        this.value = String(val);
      }
      valueOf() {
        return this.value;
      }
      toString() {
        return this.value;
      }
    },
  },
}));

import { toNumber, roundMoney, formatUSD, toMoney } from "../src/lib/money";

describe("toNumber", () => {
  it("returns 0 for null", () => {
    expect(toNumber(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(toNumber(undefined)).toBe(0);
  });

  it("passes through plain numbers", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-10.5)).toBe(-10.5);
  });

  it("parses numeric strings", () => {
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber("-50")).toBe(-50);
  });

  it("returns 0 for non-numeric strings", () => {
    expect(toNumber("not a number")).toBe(0);
    expect(toNumber("")).toBe(0);
  });

  it("handles Prisma Decimal-like objects via valueOf", () => {
    const { Prisma } = require("@prisma/client");
    const d = new Prisma.Decimal("1299.99");
    expect(toNumber(d)).toBe(1299.99);
  });
});

describe("roundMoney", () => {
  it("rounds to two decimal places", () => {
    expect(roundMoney(1.256)).toBe(1.26);
    expect(roundMoney(1.254)).toBe(1.25);
    expect(roundMoney(100)).toBe(100);
  });

  it("handles floating-point edge cases", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    // 1.005 is represented as 1.00499... in IEEE 754, so Math.round rounds down
    expect(roundMoney(1.005)).toBe(1);
  });

  it("handles negative values", () => {
    expect(roundMoney(-1.256)).toBe(-1.26);
  });

  it("handles zero", () => {
    expect(roundMoney(0)).toBe(0);
  });

  it("handles very large monetary values", () => {
    expect(roundMoney(99999.999)).toBe(100000);
    expect(roundMoney(123456.784)).toBe(123456.78);
  });
});

describe("formatUSD", () => {
  it("formats whole dollars", () => {
    expect(formatUSD(1000)).toBe("$1,000.00");
  });

  it("formats cents", () => {
    expect(formatUSD(12.5)).toBe("$12.50");
    expect(formatUSD(0.99)).toBe("$0.99");
  });

  it("formats zero", () => {
    expect(formatUSD(0)).toBe("$0.00");
  });

  it("formats negative values", () => {
    expect(formatUSD(-500)).toBe("-$500.00");
  });

  it("formats large values with commas", () => {
    expect(formatUSD(1234567.89)).toBe("$1,234,567.89");
  });
});

describe("toMoney", () => {
  it("converts and rounds in one step", () => {
    expect(toMoney("1299.999")).toBe(1300);
    expect(toMoney("49.995")).toBe(50);
  });

  it("returns 0 for null input", () => {
    expect(toMoney(null)).toBe(0);
  });

  it("returns 0 for undefined input", () => {
    expect(toMoney(undefined)).toBe(0);
  });

  it("handles Prisma Decimal-like objects", () => {
    const { Prisma } = require("@prisma/client");
    expect(toMoney(new Prisma.Decimal("1299.996"))).toBe(1300);
    expect(toMoney(new Prisma.Decimal("1299.994"))).toBe(1299.99);
  });

  it("handles plain numbers", () => {
    expect(toMoney(42.456)).toBe(42.46);
  });
});
