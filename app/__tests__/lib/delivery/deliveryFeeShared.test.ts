// /app/__tests__/lib/delivery/deliveryFeeShared.test.ts
//
// GAP-09: the delivery fee the register shows and the server writes come from
// one function, so they can't price a delivery differently.

import {
  DELIVERY_FEE_MAX,
  deliveryFeeProblem,
  deliveryPieces,
  zoneFee,
} from "@/lib/delivery/deliveryFeeShared";

describe("deliveryPieces", () => {
  it("counts each unit of goods going out on the truck", () => {
    expect(
      deliveryPieces([
        { quantity: 2, goods: true },
        { quantity: 1, goods: true },
      ]),
    ).toBe(3);
  });

  it("leaves out returns, take-with lines, non-goods and cancelled (zero) lines", () => {
    expect(
      deliveryPieces([
        { quantity: 1, goods: true },
        { quantity: 1, goods: true, isReturn: true },
        { quantity: 1, goods: true, takeWith: true },
        { quantity: 1, goods: false },
        { quantity: 0, goods: true },
        { quantity: -1, goods: true },
      ]),
    ).toBe(1);
  });

  it("sends a cut length out as one piece", () => {
    expect(deliveryPieces([{ quantity: 12.5, goods: true }])).toBe(1);
  });
});

describe("zoneFee", () => {
  it("is the base fee plus the per-piece fee for each piece", () => {
    expect(zoneFee({ baseFee: 79, perPieceFee: 15 }, 3)).toBe(124);
  });

  it("is the base fee alone when the zone has no per-piece fee", () => {
    expect(zoneFee({ baseFee: 425, perPieceFee: null }, 6)).toBe(425);
  });

  it("rounds to the cent", () => {
    expect(zoneFee({ baseFee: 0.1, perPieceFee: 0.2 }, 1)).toBe(0.3);
  });
});

describe("deliveryFeeProblem", () => {
  it("takes zero up to the ceiling", () => {
    expect(deliveryFeeProblem(0)).toBeNull();
    expect(deliveryFeeProblem(DELIVERY_FEE_MAX)).toBeNull();
  });

  it("refuses what isn't a fee", () => {
    expect(deliveryFeeProblem(-1)).toMatch(/negative/);
    expect(deliveryFeeProblem(DELIVERY_FEE_MAX + 1)).toMatch(/more than/);
    expect(deliveryFeeProblem(Number.NaN)).toMatch(/amount/);
    expect(deliveryFeeProblem("50")).toMatch(/amount/);
  });
});
