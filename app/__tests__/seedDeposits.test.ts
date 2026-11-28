// /app/__tests__/seedDeposits.test.ts
//
// What a seeded order's customer pays the day they order (orderPlan.ts
// paidAtSale). Every seeded sale used to be paid in full, so nobody in the demo
// owed anything. An order still waiting for its goods now mostly carries a
// deposit, and the rule is decided by the order's place in the plan so that no
// random draw moves.

import { DEPOSIT_SHARE, paidAtSale } from "../prisma/seed/demo/orderPlan";

const waiting = {
  index: 1,
  deliveredAt: null,
  customerId: 7,
  method: "CARD" as const,
};

describe("what a seeded order's customer pays the day they order", () => {
  it("is a deposit of half on an order still waiting for its goods", () => {
    expect(DEPOSIT_SHARE).toBe(0.5);
    expect(paidAtSale(waiting, 1060)).toBe(530);
    expect(paidAtSale({ ...waiting, method: "CASH" }, 1060)).toBe(530);
    // To the cent, half up.
    expect(paidAtSale(waiting, 99.99)).toBe(50);
  });

  it("is the whole sale once it has gone out", () => {
    expect(paidAtSale({ ...waiting, deliveredAt: new Date("2026-11-01") }, 1060)).toBe(1060);
  });

  it("is the whole sale for one waiting order in three, by its place in the plan", () => {
    const paid = [0, 1, 2, 3, 4, 5].map((index) => paidAtSale({ ...waiting, index }, 1000));
    expect(paid).toEqual([1000, 500, 500, 1000, 500, 500]);
  });

  it("is the whole sale when it is paid by gift card or store credit", () => {
    // Each is spent against a balance the seed books to the cent.
    expect(paidAtSale({ ...waiting, method: "GIFT_CARD" }, 1060)).toBe(1060);
    expect(paidAtSale({ ...waiting, method: "STORE_CREDIT" }, 1060)).toBe(1060);
  });

  it("is the whole sale when there is no customer to owe the rest", () => {
    expect(paidAtSale({ ...waiting, customerId: null }, 1060)).toBe(1060);
  });
});
