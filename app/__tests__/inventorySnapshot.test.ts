// /app/__tests__/inventorySnapshot.test.ts
//
// Pure unit tests for summarizeInventoryAggregate -- the roll-up half of the
// shared inventory aggregation (src/lib/inventory/snapshot.ts) that both
// InventoryFreeze and InventorySnapshot's LOCAL generator build on. No
// database: aggregateCurrentInventory (the groupBy half) is a thin wrapper
// around Prisma with no branching logic of its own (rule 14 -- branching
// logic belongs in pure helpers, handlers/wrappers shrink to I/O), so this
// file pins the math instead of mocking Prisma for a query with nothing to
// get wrong.

import {
  summarizeInventoryAggregate,
  type InventoryAggregateRow,
} from "@/lib/inventory/snapshot";

function row(over: Partial<InventoryAggregateRow>): InventoryAggregateRow {
  return {
    productId: 1,
    storeLocationId: 1,
    quantity: 0,
    ...over,
  };
}

describe("summarizeInventoryAggregate", () => {
  it("returns all-zero totals for an empty aggregate", () => {
    expect(summarizeInventoryAggregate([])).toEqual({
      productCount: 0,
      storeLocationCount: 0,
      totalUnits: 0,
    });
  });

  it("counts distinct products and store locations, not row count", () => {
    const summary = summarizeInventoryAggregate([
      row({ productId: 1, storeLocationId: 10, quantity: 5 }),
      // Same product at a second store -- distinct row, same product.
      row({ productId: 1, storeLocationId: 20, quantity: 3 }),
      // Different product, same store as the first row.
      row({ productId: 2, storeLocationId: 10, quantity: 7 }),
    ]);

    expect(summary.productCount).toBe(2);
    expect(summary.storeLocationCount).toBe(2);
    expect(summary.totalUnits).toBe(15);
  });

  it("sums fractional quantities without rounding", () => {
    const summary = summarizeInventoryAggregate([
      row({ productId: 1, storeLocationId: 1, quantity: 2.5 }),
      row({ productId: 2, storeLocationId: 1, quantity: 1.25 }),
    ]);

    expect(summary.totalUnits).toBe(3.75);
  });

  it("a single (product, store) row counts each dimension once", () => {
    const summary = summarizeInventoryAggregate([row({ productId: 9, storeLocationId: 4, quantity: 12 })]);

    expect(summary).toEqual({
      productCount: 1,
      storeLocationCount: 1,
      totalUnits: 12,
    });
  });
});
