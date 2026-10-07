// /app/__tests__/giftCard.test.ts

import { computeRedemption, computeReload, computeAdjustment } from "../src/lib/giftCard";

describe("computeRedemption", () => {
  it("deducts amount from balance", () => {
    const result = computeRedemption(50, 30);
    expect(result.newBalance).toBe(20);
    expect(result.newStatus).toBe("ACTIVE");
  });

  it("sets status to REDEEMED when balance reaches zero", () => {
    const result = computeRedemption(50, 50);
    expect(result.newBalance).toBe(0);
    expect(result.newStatus).toBe("REDEEMED");
  });

  it("handles penny-precision balances", () => {
    const result = computeRedemption(0.17, 0.1);
    expect(result.newBalance).toBe(0.07);
    expect(result.newStatus).toBe("ACTIVE");
  });

  it("rejects redemption exceeding balance", () => {
    expect(() => computeRedemption(20, 30)).toThrow("exceeds balance");
  });

  it("rejects zero or negative amount", () => {
    expect(() => computeRedemption(50, 0)).toThrow("greater than zero");
    expect(() => computeRedemption(50, -10)).toThrow("greater than zero");
  });

  it("avoids floating-point drift on repeated small redemptions", () => {
    let balance = 1.0;
    for (let i = 0; i < 10; i++) {
      const result = computeRedemption(balance, 0.1);
      balance = result.newBalance;
    }
    expect(balance).toBe(0);
  });
});

describe("computeReload", () => {
  it("adds amount to balance", () => {
    const result = computeReload(20, 30);
    expect(result.newBalance).toBe(50);
    expect(result.newStatus).toBe("ACTIVE");
  });

  it("reloads from zero balance", () => {
    const result = computeReload(0, 25);
    expect(result.newBalance).toBe(25);
    expect(result.newStatus).toBe("ACTIVE");
  });

  it("rejects zero or negative amount", () => {
    expect(() => computeReload(50, 0)).toThrow("greater than zero");
  });
});

describe("computeAdjustment", () => {
  it("computes delta for upward adjustment", () => {
    const result = computeAdjustment(20, 100);
    expect(result.delta).toBe(80);
    expect(result.newStatus).toBe("ACTIVE");
  });

  it("computes delta for downward adjustment", () => {
    const result = computeAdjustment(100, 20);
    expect(result.delta).toBe(80);
    expect(result.newStatus).toBe("ACTIVE");
  });

  it("sets REDEEMED when adjusted to zero", () => {
    const result = computeAdjustment(50, 0);
    expect(result.delta).toBe(50);
    expect(result.newStatus).toBe("REDEEMED");
  });

  it("rejects negative balance", () => {
    expect(() => computeAdjustment(50, -10)).toThrow("cannot be negative");
  });

  it("handles same-balance adjustment with zero delta", () => {
    const result = computeAdjustment(50, 50);
    expect(result.delta).toBe(0);
    expect(result.newStatus).toBe("ACTIVE");
  });
});
