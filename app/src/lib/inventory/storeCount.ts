// /app/src/lib/inventory/storeCount.ts
//
// The store-grain count (Inventory > Physical count, the variance report and
// reconciliation): what was counted against the snapshot, per product. Kept
// as the check that a POS cutover counted right.
//
// A count is a quantity like the balance, Decimal(12,3), because a roll of
// fabric is counted in yards. Until 2026-10-16 the columns were Int, and
// Prisma truncated silently: a count of 12.5 yards was stored as 12, and two
// scans of 0.1 and 0.2 as 0 and 0, so an accurate count read as 0.3 missing.
//
// Sums are rounded to the stock precision, so float noise (0.1 + 0.2) never
// turns an accurate count into a variance of 0.0000000000000001.

import type { Prisma } from "@prisma/client";
import { roundQty, toQty } from "./quantity";

type Qty = Prisma.Decimal | number;

/** Counted quantity per product, summed over every scan. */
export function countedByProduct(rows: { productId: number; quantity: Qty }[]) {
  const counted = new Map<number, number>();
  for (const r of rows) {
    counted.set(r.productId, roundQty((counted.get(r.productId) ?? 0) + toQty(r.quantity)));
  }
  return counted;
}

/** Counted minus expected, to the stock precision. */
export function countVariance(counted: number, expected: number): number {
  return roundQty(counted - expected);
}

/** A count row on its way to a screen: JSON sends a Decimal as text. */
export function countForClient<T extends { quantity: Qty }>(row: T) {
  return { ...row, quantity: toQty(row.quantity) };
}

/** A reconciliation on its way to a screen or a CSV, every quantity a number. */
export function reconciliationForClient<
  T extends {
    initialExpected: Qty;
    initialCounted: Qty;
    initialVariance: Qty;
    finalCount: Qty;
    finalVariance: Qty;
  },
>(row: T) {
  return {
    ...row,
    initialExpected: toQty(row.initialExpected),
    initialCounted: toQty(row.initialCounted),
    initialVariance: toQty(row.initialVariance),
    finalCount: toQty(row.finalCount),
    finalVariance: toQty(row.finalVariance),
  };
}
