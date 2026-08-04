// /app/src/lib/inventory/snapshot.ts
//
// "What does holt currently think is on hand" -- the one aggregation both
// InventoryFreeze (durable point-in-time record) and InventorySnapshot's
// LOCAL generator (the transient baseline a physical count is measured
// against) build from. Before this file existed, the freeze endpoint had its
// own inline groupBy and nothing else read InventoryPosition the same way;
// if the snapshot generator had grown its own copy, the two would have been
// free to drift -- e.g. one adding a `quantity: { gt: 0 }` filter the other
// forgot -- and nobody would notice until a manager compared a freeze and a
// snapshot for the same day and got different totals. One function, two
// callers, can't drift.
//
// Grain is (productId, storeLocationId), not stockLocationId. Physical counts
// are run per store, not per bin (see InventorySnapshot's schema comment),
// and this matches how InventoryFreeze has aggregated since it shipped.

import type { Prisma, PrismaClient } from "@prisma/client";

type PrismaTx = PrismaClient | Prisma.TransactionClient;

export interface InventoryAggregateRow {
  productId: number;
  storeLocationId: number;
  quantity: number;
}

/**
 * Current on-hand inventory, summed by product + store location, positive
 * quantity only (rule 31/39's sibling for this domain: a zero-or-negative
 * position is not stock on the floor). Reads InventoryPosition directly --
 * the daily-overwritten table that is holt's own record of on-hand, not a
 * POS export.
 */
export async function aggregateCurrentInventory(tx: PrismaTx): Promise<InventoryAggregateRow[]> {
  const positions = await tx.inventoryPosition.groupBy({
    by: ["productId", "storeLocationId"],
    _sum: { quantity: true },
    where: { quantity: { gt: 0 } },
  });

  return positions.map((p) => ({
    productId: p.productId,
    storeLocationId: p.storeLocationId,
    quantity: p._sum.quantity || 0,
  }));
}

export interface InventoryAggregateSummary {
  productCount: number;
  storeLocationCount: number;
  totalUnits: number;
}

/**
 * Pure roll-up over an aggregate result: distinct products, distinct store
 * locations, total units. No I/O, so every branch is unit-tested without a
 * database. Used for the snapshot-generate response counts.
 */
export function summarizeInventoryAggregate(
  rows: InventoryAggregateRow[],
): InventoryAggregateSummary {
  const productIds = new Set<number>();
  const storeLocationIds = new Set<number>();
  let totalUnits = 0;

  for (const row of rows) {
    productIds.add(row.productId);
    storeLocationIds.add(row.storeLocationId);
    totalUnits += row.quantity;
  }

  return {
    productCount: productIds.size,
    storeLocationCount: storeLocationIds.size,
    totalUnits,
  };
}
