// /app/__tests__/poSellThruForCaller.test.ts
//
// What the PO Sell-Thru report sends a viewer with and without "View cost"
// (SEC-14). Pure: Prisma is a type-only import in lib/reports/poSellThru.ts.

import { computePerformance, FRAME_PUBLIC_FIELDS } from "@/lib/buyPerformance";
import { poSellThruForCaller, type PoSellThruResponse } from "@/lib/reports/poSellThru";

const COST_FIELDS = [
  "totalCost",
  "costOfSold",
  "stockCostOfSold",
  "specialCostOfSold",
  "grossProfit",
  "marginRatio",
  "stockMarginRatio",
  "specialMarginRatio",
  "hasEstimatedCost",
];

// Two frames: one sold (stock and special, one line with no cost so the margin
// is estimated), one received but unsold with no realized retail.
const frames = computePerformance(
  [
    {
      draftId: 0,
      qty: 2,
      costPerUnit: 450,
      retailPerUnit: 0,
      fulfilledProductId: 1,
      frameKey: "A",
      frameLabel: "Sofa A",
    },
    {
      draftId: 0,
      qty: 10,
      costPerUnit: 50,
      retailPerUnit: 0,
      fulfilledProductId: 3,
      frameKey: "B",
      frameLabel: "Lamp B",
    },
  ],
  [
    { productId: 1, qty: 1, netPrice: 900, cost: 450 },
    { productId: 2, qty: 1, netPrice: 1200, cost: null },
  ],
  new Map([
    [1, "A"],
    [2, "A"],
    [3, "B"],
  ]),
  { daysSinceBuyExported: 30, stockProductIds: new Set([1, 3]) },
  [
    { productId: 1, qty: 2 },
    { productId: 3, qty: 10 },
  ],
);

const response: PoSellThruResponse = {
  pos: [
    {
      poNumber: "PO-1",
      vendorName: "Vendor",
      orderDate: "2026-09-01T00:00:00.000Z",
      status: "CONFIRMED",
      lineCount: 2,
    },
  ],
  notFound: ["PO-MISSING"],
  frames: frames.map((f) => ({ ...f, realizedRetailRatio: f.frameKey === "A" ? 0.84 : null })),
  rollup: {
    totalQtyOrdered: 12,
    totalQtyReceived: 12,
    totalQtyStockSold: 1,
    totalQtySpecialSold: 1,
    totalRevenue: 2100,
    overallStockSellThrough: 1 / 12,
    overallMargin: 0.5,
    overallRealizedRetail: 0.84,
  },
};

describe("poSellThruForCaller (View cost)", () => {
  it("a holder gets the report unchanged", () => {
    expect(poSellThruForCaller(response, true)).toEqual({ ...response, costVisible: true });
  });

  it("anyone else gets frames with FRAME_PUBLIC_FIELDS and realized retail only", () => {
    const blind = poSellThruForCaller(response, false);
    expect(blind.costVisible).toBe(false);
    expect(blind.frames).toHaveLength(2);
    const expectedKeys = [...FRAME_PUBLIC_FIELDS, "realizedRetailRatio"].sort();
    blind.frames.forEach((f, i) => {
      expect(Object.keys(f).sort()).toEqual(expectedKeys);
      for (const k of COST_FIELDS) expect(f).not.toHaveProperty(k);
      const full = response.frames[i];
      for (const k of FRAME_PUBLIC_FIELDS) expect(f[k]).toEqual(full[k]);
      expect(f.realizedRetailRatio).toBe(full.realizedRetailRatio);
    });
    // computePerformance's revenue order, untouched.
    expect(blind.frames.map((f) => f.frameKey)).toEqual(["A", "B"]);
  });

  it("drops the overall margin from the rollup and keeps the PO chips and not-found list", () => {
    const blind = poSellThruForCaller(response, false);
    expect(blind.rollup).not.toHaveProperty("overallMargin");
    const { overallMargin, ...rest } = response.rollup;
    expect(overallMargin).toBe(0.5); // the input is left whole
    expect(blind.rollup).toEqual(rest);
    expect(blind.pos).toEqual(response.pos);
    expect(blind.notFound).toEqual(["PO-MISSING"]);
  });
});
