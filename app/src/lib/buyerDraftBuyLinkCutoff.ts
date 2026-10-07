// /app/src/lib/buyerDraftBuyLinkCutoff.ts
//
// Pure helper: compute the orderDate cutoff for "real POs that could
// plausibly belong to a given Buy."
//
// THE PROBLEM
// -----------
// Slice 6.8 (PR #272) and Slice 6.8.1 (PR #275) joined real POs to a
// buyer-draft Buy via `BuyerDraftItem.fulfilledProductId ===
// PurchaseOrderItem.productId`. The match is empirically the right
// signal at the draft level — the buyer set it explicitly when they
// resolved the draft to a Product.
//
// What we didn't anticipate: products live for years. A product first
// stocked in 2023 (with receivings, sales, several POs through history)
// retains the same `Product.id` when reordered for a 2026 Buy. The
// productId match then drags in every PO that ever carried that
// product, including ones from 2023 that have nothing to do with this
// buy.
//
// User-reported symptom: a seasonal buy's performance page showed
// years of prior sales and an all-time receiving qty, even though the
// buy itself had just been created. Reproduced against a restored
// backup: dozens of real POs matched via productId, the earliest years
// before the buy existed. The earliest receivedDate of those POs
// became the salesWindow.start, opening the gate for every later sale
// of any matched product.
//
// THE FIX
// -------
// Bound the productId match by `PurchaseOrder.orderDate`. Real POs
// placed BEFORE this buy's window can't have been driven by this buy
// — they belong to prior buys. Cutoff = earliest expectedShipMonth
// across the buy's draft POs MINUS a 12-month lead-time buffer.
//
// Why 12 months: Spring 2026 buys are typically placed at fall market
// (Oct 2025), with ship months Jan-Apr 2026. 12 months before the
// earliest ship month (= Jan 2025) covers any reasonable place-to-ship
// gap with slack. Tightening further would risk excluding legitimate
// long-lead-time POs.
//
// Falls back to `buy.created - 12 months` if no draft PO has
// expectedShipMonth set yet. Returns null when neither signal is
// available (caller treats null as "no bound" — full productId match).
//
// No upper bound: a real PO placed after the buy's latest
// expectedShipMonth can legitimately fulfill a slipped/reordered
// draft. Only the lower bound stops the historical-noise problem.

export interface DraftPoForCutoff {
  expectedShipMonth: Date | null;
}

/**
 * Compute the orderDate cutoff for "real POs that could plausibly
 * belong to this Buy." Returns null when we have no signal — caller
 * treats null as no bound. The fallback chain is:
 *   1. Earliest expectedShipMonth across the buy's draft POs
 *   2. The buy's `created` timestamp
 * minus `monthsBefore` months.
 *
 * Default `monthsBefore = 12` covers typical seasonal lead times.
 * Callers can tighten (e.g. for mid-season replenishment buys) or
 * widen (for long-lead-time custom furniture) by passing a different
 * value.
 */
export function computeBuyLinkCutoff(
  draftPos: readonly DraftPoForCutoff[],
  buyCreated: Date,
  monthsBefore = 12,
): Date | null {
  let earliestShip: Date | null = null;
  for (const p of draftPos) {
    if (p.expectedShipMonth === null) continue;
    if (earliestShip === null || p.expectedShipMonth < earliestShip) {
      earliestShip = p.expectedShipMonth;
    }
  }
  const anchor = earliestShip ?? buyCreated;
  const cutoff = new Date(anchor);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - monthsBefore);
  return cutoff;
}
