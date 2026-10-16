// /app/__tests__/storeCount.test.ts
//
// The store-grain count's arithmetic (lib/inventory/storeCount.ts) and the
// count a person types (lib/inventory/qtyInput.ts parseCount).

import { Prisma } from "@prisma/client";
import {
  countedByProduct,
  countForClient,
  countVariance,
  reconciliationForClient,
} from "@/lib/inventory/storeCount";
import { parseCount } from "@/lib/inventory/qtyInput";

describe("countedByProduct", () => {
  it("sums each product's scans, Decimal or number, to the stock precision", () => {
    const counted = countedByProduct([
      { productId: 1, quantity: new Prisma.Decimal("0.1") },
      { productId: 1, quantity: 0.2 },
      { productId: 2, quantity: new Prisma.Decimal("12.625") },
    ]);
    expect(counted.get(1)).toBe(0.3);
    expect(counted.get(2)).toBe(12.625);
  });
});

describe("countVariance", () => {
  it("is exactly zero when the count matches, despite float noise", () => {
    expect(countVariance(0.1 + 0.2, 0.3)).toBe(0);
  });

  it("keeps an eighth of a yard", () => {
    expect(countVariance(12.5, 12.625)).toBe(-0.125);
  });
});

describe("sending to a screen", () => {
  it("turns a count's Decimal into a number", () => {
    expect(countForClient({ id: 1, quantity: new Prisma.Decimal("12.5") })).toEqual({
      id: 1,
      quantity: 12.5,
    });
  });

  it("turns every reconciliation quantity into a number", () => {
    const d = (s: string) => new Prisma.Decimal(s);
    expect(
      reconciliationForClient({
        location: "Mill",
        initialExpected: d("12.625"),
        initialCounted: d("12.5"),
        initialVariance: d("-0.125"),
        finalCount: d("12.375"),
        finalVariance: d("-0.25"),
      }),
    ).toEqual({
      location: "Mill",
      initialExpected: 12.625,
      initialCounted: 12.5,
      initialVariance: -0.125,
      finalCount: 12.375,
      finalVariance: -0.25,
    });
  });
});

describe("parseCount", () => {
  it("reads a part roll and keeps three places", () => {
    expect(parseCount("12.5")).toBe(12.5);
    expect(parseCount(12.3456)).toBe(12.346);
  });

  it("takes zero: none found is a count", () => {
    expect(parseCount(0)).toBe(0);
    expect(parseCount("0")).toBe(0);
  });

  it("refuses what is not a count", () => {
    expect(parseCount(-1)).toBeNull();
    expect(parseCount("lots")).toBeNull();
    expect(parseCount("")).toBeNull();
    expect(parseCount(null)).toBeNull();
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount(Number.NaN)).toBeNull();
    expect(parseCount(Infinity)).toBeNull();
  });
});
