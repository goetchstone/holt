// /app/__tests__/designerDashboardCost.test.ts
//
// Pins the OrderLineItem.cost LINE-TOTAL invariant in the designer dashboard.
// Bug class: cost was multiplied by orderedQuantity in accumulateLineItem,
// double-counting COGS for every multi-qty line (every other reader --
// journalEntry, grossMargin, topSellers, buyersReport -- treats cost as the
// extended line total, the sister invariant to netPrice). This test fails if
// the multiplication is ever reintroduced.

import {
  accumulateLineItem,
  type CategoryMetrics,
  type DashboardLineItem,
} from "@/lib/reports/designerDashboard";

function emptyResult(): Record<string, CategoryMetrics> {
  return {
    All: { revenue: 0, cost: 0, count: 0 },
    Furniture: { revenue: 0, cost: 0, count: 0 },
  };
}

function line(overrides: Partial<DashboardLineItem> = {}): DashboardLineItem {
  return {
    netPrice: 400, // line total: 4 units @ $100
    cost: 200, // line total: 4 units @ $50 wholesale
    orderedQuantity: 4,
    product: { department: { name: "Furniture" } },
    ...overrides,
  };
}

describe("accumulateLineItem cost invariant (line total, never x qty)", () => {
  it("uses cost as the line total — does NOT multiply by orderedQuantity", () => {
    const result = emptyResult();
    accumulateLineItem(result, line(), 1);
    expect(result.All.cost).toBe(200); // pre-fix behavior produced 800
    expect(result.All.revenue).toBe(400);
  });

  it("applies only the split multiplier to cost", () => {
    const result = emptyResult();
    accumulateLineItem(result, line(), 0.5);
    expect(result.All.cost).toBe(100);
    expect(result.All.revenue).toBe(200);
  });

  it("qty=1 lines are unaffected either way (the case that hid the bug)", () => {
    const result = emptyResult();
    accumulateLineItem(result, line({ netPrice: 100, cost: 50, orderedQuantity: 1 }), 1);
    expect(result.All.cost).toBe(50);
  });

  it("accumulates into the matched category and the All bucket", () => {
    const result = emptyResult();
    accumulateLineItem(result, line(), 1);
    expect(result.Furniture.cost).toBe(200);
    expect(result.Furniture.count).toBe(1);
    expect(result.All.count).toBe(1);
  });
});
