// /app/src/lib/sales/bulkSalespersonShared.ts
//
// The bulk salesperson correction's result, shared by the route
// (pages/api/admin/sales/bulk-update-salesperson.ts) and its screen
// (SalespersonCorrectionsView), so the screen can say which orders were
// refused and why. A bare "3 failed." left a manager nothing to act on.

export interface BulkSalespersonError {
  orderId: number;
  reason: string;
}

export interface BulkSalespersonResult {
  updated: number;
  errors: BulkSalespersonError[];
}

/**
 * The route's reason when a row keeps the order's split and that split
 * partner is the person the order is being reassigned to. Nobody can be both
 * salesperson and split partner, so the order is refused, and the reason
 * names the screen's choice that resolves it.
 */
export const KEPT_SPLIT_IS_NEW_SALESPERSON =
  'Already split with this salesperson. Choose "No split (remove it)" or another split partner for this order.';

export interface BulkSalespersonFailure {
  orderId: number;
  orderno: string;
  reason: string;
}

/** Each refused order by its order number, with the route's reason. */
export function bulkSalespersonFailures(
  errors: readonly BulkSalespersonError[],
  orders: readonly { id: number; orderno: string }[],
): BulkSalespersonFailure[] {
  const numberOf = new Map(orders.map((o) => [o.id, o.orderno]));
  return errors.map((e) => ({
    orderId: e.orderId,
    orderno: numberOf.get(e.orderId) ?? `Order #${e.orderId}`,
    reason: e.reason,
  }));
}

export type BulkSalespersonSummaryLevel = "success" | "warning" | "error" | "info";

/** The one-line toast for a bulk result. The refused orders are listed beside it. */
export function bulkSalespersonSummary(result: BulkSalespersonResult): {
  level: BulkSalespersonSummaryLevel;
  message: string;
} {
  const { updated } = result;
  const refused = result.errors.length;
  if (refused === 0) {
    return updated > 0
      ? { level: "success", message: `Updated ${updated} order(s).` }
      : { level: "info", message: "No orders needed a change." };
  }
  const notChanged = `${refused} order(s) were not changed; the list below says why.`;
  return updated > 0
    ? { level: "warning", message: `Updated ${updated} order(s). ${notChanged}` }
    : { level: "error", message: `No orders were updated. ${notChanged}` };
}
