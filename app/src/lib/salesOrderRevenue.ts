// /app/src/lib/salesOrderRevenue.ts
//
// Canonical list of SalesOrder.status values that contribute to a
// customer's NET spend / revenue / attribution math.
//
// Why this constant exists -- the failure shape we keep hitting:
//
//   const where = { status: { in: ["ORDER", "FULFILLED"] } };  // ❌ MISSING RETURNED
//
// Filtering to just ORDER + FULFILLED silently drops every accounting
// return (accounting-return orders, `status = RETURNED`). Those rows hold
// the NEGATIVE line items that cancel out the original (and the rewrite
// chain, see CLAUDE.md "Rewrites" gotcha). Without them, a base order
// + its rewrite both count -- exact double-counting of any rewritten
// sale. Symptom when this is wrong: a customer with a returned order
// shows inflated attributed revenue because the negative return rows
// were dropped; their real net spend is lower once returns net out.
//
// Use `SALES_REVENUE_STATUSES` for any aggregation that asks "what did
// this customer / campaign / dept / window actually generate in
// revenue?" The negative netPrice rows on RETURNED orders are how
// returns net out the corresponding positive lines.
//
// When NOT to use this constant -- a few legitimate exclusion cases:
//
//   * Dispatch / ready-to-deliver boards: filter to `status = "ORDER"`
//     only. RETURNED orders don't ship.
//   * Marking consignment items SOLD on import: filter to
//     ORDER + FULFILLED only. A returned consignment item should NOT
//     be marked SOLD just because it appears on an accounting-return row.
//   * Purchasing pipeline (`needs-ordering`): filter to active orders
//     awaiting fulfillment; RETURNED isn't relevant.
//
// In those cases, hard-code the narrower filter inline and add a
// one-line comment explaining why -- so future Sonar / grep audits can
// distinguish "intentionally narrower" from "forgot RETURNED."

export const SALES_REVENUE_STATUSES = ["ORDER", "FULFILLED", "RETURNED"] as const;

export type SalesRevenueStatus = (typeof SALES_REVENUE_STATUSES)[number];

// The line-level sister rule (CLAUDE.md rule 33): which OrderLineItem
// statuses are still owed by the customer.
//
//   ACTIVE       the line as sold
//   BACKORDERED  still sold, just not here yet
//   CANCELLED    out -- cancelling a line keeps its netPrice for the record
//   REPLACED     out -- the ACTIVE replacement line carries the amount now;
//                counting both charges for the item twice
//
// Cancelling or replacing a line changes its status and leaves its price in
// place, so any total that skips this filter keeps charging for it.
export const COUNTED_LINE_STATUSES = ["ACTIVE", "BACKORDERED"] as const;
export type CountedLineStatus = (typeof COUNTED_LINE_STATUSES)[number];

/** True when a line with this status is still owed (see COUNTED_LINE_STATUSES). */
export function isCountedLine(status: string): boolean {
  return (COUNTED_LINE_STATUSES as readonly string[]).includes(status);
}
