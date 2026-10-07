// /app/src/lib/frameSalesHistory.ts
//
// Slice 6.12 (2026-05-14) — pure helper for trailing-N-months frame
// sales rollup. Used by the BarcodeLookupModal preview and the item
// card badge to surface operational awareness at the moment the
// buyer is making a quantity decision.
//
// "Frame sales" = sales of any product sharing the SKU stem (the part
// before the last `-` segment, e.g. `WH-L2272` is the frame for
// `WH-L2272-G16-A`, `WH-L2272-G18-B`, etc.). Caller pre-computes the
// frame-mate product set (via `frameRollup.stripLastSegment`) and
// passes the line items. The helper does the math.
//
// CLAUDE.md compliance:
//   - rule 33  → caller must pre-filter cancelled lineItemStatus
//   - rule 47  → caller scopes orders to SALES_REVENUE_STATUSES
//                (`ORDER`, `FULFILLED`, `RETURNED`); RETURNED stays in
//                so its negative qty/netPrice subtracts correctly
//   - netPrice = line total invariant (no qty multiply)

export interface FrameSaleLine {
  /** netPrice is line total (qty × unit_net). CLAUDE.md gotcha. */
  netPrice: number;
  /** Signed quantity — RETURNED rows are negative. */
  qty: number;
  /** Used for distinct-order counting. */
  salesOrderId: number;
}

export interface FrameSalesHistory {
  /** Sum of qty across the window. Net of returns. */
  units: number;
  /** Sum of netPrice across the window. Net of returns. */
  revenue: number;
  /** Number of distinct SalesOrders that contributed at least one
   *  line (positive or negative — RETURNED counts as an order
   *  touching this frame, but the caller can split if desired). */
  distinctOrders: number;
  /** The trailing window in months (echoed back for UI display). */
  windowMonths: number;
}

export function computeFrameSalesHistory(
  lines: readonly FrameSaleLine[],
  windowMonths: number,
): FrameSalesHistory {
  const distinctOrderIds = new Set<number>();
  let units = 0;
  let revenue = 0;
  for (const l of lines) {
    units += l.qty;
    revenue += l.netPrice;
    distinctOrderIds.add(l.salesOrderId);
  }
  return {
    units,
    revenue: Math.round(revenue * 100) / 100,
    distinctOrders: distinctOrderIds.size,
    windowMonths,
  };
}

/**
 * Compute the lower bound for a trailing N-months window from `now`.
 * Always inclusive — `gte` against orderDate. Tests pass `now` for
 * determinism.
 */
export function trailingWindowStart(now: Date, months: number): Date {
  const out = new Date(now);
  out.setUTCMonth(out.getUTCMonth() - months);
  return out;
}
