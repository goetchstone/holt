// /app/__tests__/returnMoney.test.ts
//
// The money rules of a native return (lib/returns/returnMoney.ts): what came
// back is worth, the restocking fee, and what is left to refund.

import {
  computeReturnRefundable,
  computeReturnValue,
  resolveRestockingFee,
  ReturnMoneyError,
} from "@/lib/returns/returnMoney";

const line = { netPrice: 1000, vatAmount: 63.5, cost: 400, orderedQuantity: 4 };

describe("computeReturnValue", () => {
  it("prorates net, tax and cost by quantity, part rolls included", () => {
    expect(computeReturnValue(line, 2.5)).toEqual({
      quantity: 2.5,
      net: 625,
      tax: 39.69,
      cost: 250,
    });
  });

  it("the return that completes the line takes the remainder, so no cent is lost", () => {
    const thirds = { netPrice: 100, vatAmount: 6.35, cost: 40, orderedQuantity: 3 };
    const first = computeReturnValue(thirds, 1);
    const second = computeReturnValue(thirds, 1, { ...first, quantity: 1 });
    const booked = {
      quantity: 2,
      net: first.net + second.net,
      tax: first.tax + second.tax,
      cost: first.cost + second.cost,
    };
    const last = computeReturnValue(thirds, 1, booked);
    expect(first.net + second.net + last.net).toBeCloseTo(100, 10);
    expect(first.tax + second.tax + last.tax).toBeCloseTo(6.35, 10);
    expect(first.cost + second.cost + last.cost).toBeCloseTo(40, 10);
  });

  it("refuses nothing, and more than is left on the line", () => {
    expect(() => computeReturnValue(line, 0)).toThrow(ReturnMoneyError);
    expect(() => computeReturnValue(line, 5)).toThrow("Only 4 of 4");
    expect(() =>
      computeReturnValue(line, 2, { quantity: 3, net: 750, tax: 47.63, cost: 300 }),
    ).toThrow("Only 1 of 4");
  });
});

describe("resolveRestockingFee", () => {
  it("is 0 unless staff give one", () => {
    expect(resolveRestockingFee(1000, null)).toBe(0);
    expect(resolveRestockingFee(1000, undefined)).toBe(0);
  });

  it("takes a percent of the goods' net, or an amount", () => {
    expect(resolveRestockingFee(1000, { percent: 15 })).toBe(150);
    expect(resolveRestockingFee(333.33, { percent: 10 })).toBe(33.33);
    expect(resolveRestockingFee(1000, { amount: 75 })).toBe(75);
  });

  it("is never more than the goods are worth, and never negative", () => {
    expect(resolveRestockingFee(100, { amount: 250 })).toBe(100);
    expect(resolveRestockingFee(100, { percent: 120 })).toBe(100);
    expect(() => resolveRestockingFee(100, { amount: -5 })).toThrow("cannot be negative");
  });
});

describe("computeReturnRefundable", () => {
  const value = { quantity: 1, net: 1000, tax: 63.5, cost: 400 };

  it("is the value incl. tax, less the fee", () => {
    expect(computeReturnRefundable({ value, fee: 150, refunds: [] })).toEqual({
      total: 913.5,
      refunded: 0,
      refundable: 913.5,
    });
  });

  it("counts COMPLETED, PENDING and legacy refunds; a FAILED or VOIDED one paid nothing", () => {
    const r = computeReturnRefundable({
      value,
      fee: 150,
      refunds: [
        { amount: 100, status: "COMPLETED" },
        { amount: 200, status: "PENDING" },
        { amount: 50, status: null },
        { amount: 400, status: "FAILED" },
        { amount: 400, status: "VOIDED" },
      ],
    });
    expect(r.refunded).toBe(350);
    expect(r.refundable).toBe(563.5);
  });

  it("never goes below zero", () => {
    expect(
      computeReturnRefundable({ value, fee: 0, refunds: [{ amount: 2000, status: "COMPLETED" }] })
        .refundable,
    ).toBe(0);
  });
});
