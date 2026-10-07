// /app/src/lib/auth/costVisibility.ts
//
// "View cost" (catalog.cost, SEC-14): whether a caller may see what the store
// pays. It is never a gate. A screen that shows cost beside other figures is
// served to everyone its own key admits, and the cost is left out for a caller
// without this one (strip, never deny: locking someone out of a working screen
// is worse than the leak it would prevent).
//
// A route opts in with WITH_COST on its gate, which answers the key from the
// same staff read as the gate itself, then asks canViewCost(access):
//
//   async function handler(req, res, _session, access) {
//     const showCost = canViewCost(access);
//     ...
//     res.json({ rows, costVisible: showCost });
//   }
//   export default requirePermission("inventory.read", handler, WITH_COST);
//
// The response says `costVisible`, so the screen hides its cost columns from
// the same answer that stripped them, rather than guessing from missing fields.

import type { CallerAccess, GateOptions } from "@/lib/auth/gateOptions";

export const VIEW_COST = "catalog.cost";

/** Gate option: also answer whether the caller holds "View cost". */
export const WITH_COST: GateOptions = { also: [VIEW_COST] };

/**
 * Does the caller hold "View cost"? Throws when the route's gate did not ask
 * (no WITH_COST): answering "no" there would quietly strip cost from everyone,
 * holders included.
 */
export function canViewCost(access: CallerAccess): boolean {
  if (!(VIEW_COST in access.holds)) {
    throw new Error("canViewCost: this route's gate does not ask for View cost; pass WITH_COST");
  }
  return access.holds[VIEW_COST];
}

/** The cost fields of an inventory valuation row: the Inventory hub's on-hand
 *  totals (by department, by location) and Summary Details. */
export const VALUATION_COST_FIELDS = ["expectedCost", "countedCost", "varianceCost"] as const;

/**
 * Rows as they go to the caller, and whether they carry cost: unchanged for a
 * holder of View cost; without `costFields` for anyone else. Strip at the edge,
 * so the arithmetic that builds the rows stays one code path.
 */
export function rowsWithCostFor<T extends object>(
  access: CallerAccess,
  rows: readonly T[],
  costFields: readonly string[],
): { rows: Array<Partial<T>>; costVisible: boolean } {
  const costVisible = canViewCost(access);
  if (costVisible) return { rows: [...rows], costVisible };
  return {
    rows: rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => !costFields.includes(key)),
        ) as Partial<T>,
    ),
    costVisible,
  };
}

/**
 * An update body as it may be written for the caller: unchanged for a holder of
 * "View cost"; without `costFields` for anyone else, so a screen that never
 * received cost cannot save it back as empty or zero. A field left out means
 * "unchanged". Shallow: it reads the body's top-level keys only.
 */
export function dropCostWrites<T extends object>(
  access: CallerAccess,
  body: T,
  costFields: readonly string[],
): Partial<T> {
  if (canViewCost(access)) return body;
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !costFields.includes(key)),
  ) as Partial<T>;
}
