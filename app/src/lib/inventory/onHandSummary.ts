// /app/src/lib/inventory/onHandSummary.ts
//
// What the register shows beside a cart line: how much of the product is free
// to sell at each store. The register asks /api/warehouse/positions for the
// product's FREE positions (freeOnly) -- stock committed to another order is
// not on hand for this sale -- and folds them by store here.
//
// It used to read `storeLocation.name`, which that route does not send (it
// sends `locationName`), so every row was skipped and each line said nothing
// was on hand.

import { roundQty } from "./quantity";

export interface OnHandAtStore {
  locationName: string;
  available: number;
}

export function onHandByStore(
  rows: { locationName?: string | null; quantity: number }[],
): OnHandAtStore[] {
  const byStore = new Map<string, number>();
  for (const row of rows) {
    if (!row.locationName || !(row.quantity > 0)) continue;
    byStore.set(row.locationName, roundQty((byStore.get(row.locationName) ?? 0) + row.quantity));
  }
  return Array.from(byStore, ([locationName, available]) => ({ locationName, available }));
}
