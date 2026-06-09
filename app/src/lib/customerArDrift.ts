// /app/src/lib/customerArDrift.ts
//
// Phase 0.5.5 (2026-05-12) — daily AR-drift cross-check.
//
// For each customer that's active (per the activity-window helper below),
// compare:
//   stored: `Customer.openArBalance` — the running total maintained by
//           `appendEntry` on every payment/refund/sale
//   derived: `computeSourceBalance(orders)` — the live re-derivation from
//           the underlying SalesOrder + Payment + OrderLineItem rows
//
// If they diverge beyond `LEDGER_TOLERANCE` (0.005 = half a cent), the
// customer is flagged. The cron writes the drift report to a log file and
// surfaces the count on the admin dashboard so it's noticeable but not
// noisy.
//
// Why daily and not on every write: an in-transaction guard would either
// be too expensive (recomputes every customer's source balance on every
// payment) or partial (only re-checks the touched customer's recent
// orders). A daily walk is the simplest catch-all — if the wire breaks
// somewhere (a bypass of `appendEntry`, a VOIDED payment without a
// matching ledger entry, a manual SQL UPDATE on the source side), we
// hear about it next day instead of next quarter.
//
// Pure helper. No DB access. The API endpoint hydrates the inputs.

import {
  validateAgainstSource,
  computeSourceBalance,
  type OrderForLedgerSource,
} from "@/lib/customerLedger";

/** One customer's snapshot for the drift comparison. */
export interface CustomerArInput {
  customerId: number;
  /** Last name + first initial or display name — used in the report only. */
  label: string;
  /** Stored `Customer.openArBalance`. Number-coerced before passing. */
  storedBalance: number;
  /** All non-cancelled orders for this customer (with their line items + payments). */
  orders: ReadonlyArray<OrderForLedgerSource>;
}

export interface DriftRow {
  customerId: number;
  label: string;
  /** What `Customer.openArBalance` says. */
  storedBalance: number;
  /** What the source-of-truth sum says. */
  sourceBalance: number;
  /** Signed: positive means stored is HIGHER than source (we think they owe
   *  more than they actually do). Negative = stored is LOWER (we think they
   *  owe less than they actually do — usually the more concerning direction). */
  diff: number;
  /** Human-readable hint with the same shape `validateAgainstSource` uses. */
  message: string;
}

export interface ArDriftReport {
  /** Total customers checked. */
  checked: number;
  /** Customers whose stored matches source within LEDGER_TOLERANCE. */
  ok: number;
  /** Customers flagged. Empty array means all good. */
  drifted: DriftRow[];
  /** Sum of absolute drift amounts — useful for "is this catastrophic or one off-by-a-penny?" */
  totalAbsoluteDrift: number;
}

/**
 * Walk the customer snapshots and produce a drift report. Pure: no I/O,
 * deterministic for a given input.
 *
 * Drift direction note for callers reading this in three months: a
 * NEGATIVE diff (storedBalance < sourceBalance) means we BELIEVE the
 * customer owes LESS than the source rows say. That's the worse failure
 * mode — under-billing missed by the running total. Flag those rows
 * loudly in the UI.
 */
export function compareCustomerArBalances(inputs: ReadonlyArray<CustomerArInput>): ArDriftReport {
  let ok = 0;
  let totalAbsoluteDrift = 0;
  const drifted: DriftRow[] = [];

  for (const c of inputs) {
    const sourceBalance = computeSourceBalance(c.orders);
    const v = validateAgainstSource(c.storedBalance, sourceBalance);
    if (v.ok) {
      ok += 1;
      continue;
    }
    totalAbsoluteDrift += Math.abs(v.diff);
    drifted.push({
      customerId: c.customerId,
      label: c.label,
      storedBalance: v.ledgerBalance,
      sourceBalance: v.sourceBalance,
      diff: v.diff,
      message: v.message ?? "",
    });
  }

  // Sort by absolute diff descending — biggest problems first in the UI.
  drifted.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    checked: inputs.length,
    ok,
    drifted,
    totalAbsoluteDrift: Math.round(totalAbsoluteDrift * 100) / 100,
  };
}

/**
 * Decide which customers to check on a given run. Returns the customer
 * id set that the API endpoint should hydrate orders+payments for.
 *
 * Strategy: any customer with ledger or payment activity in the last
 * `lookbackHours`. Walking ALL customers daily would be wasteful — most
 * have no activity and their stored balance is by definition correct
 * (no events happened to invalidate it). The lookback window is
 * configurable so future tuning (e.g. weekly full sweep) can extend it.
 *
 * Returns null when given an empty input — caller defaults to "all
 * customers with non-zero openArBalance" in that case (handles the
 * post-backfill cold start where there's no recent activity yet but
 * thousands of balances were just established).
 */
export function selectCustomersForCheck(input: {
  paymentCustomerIds: ReadonlyArray<number>;
  ledgerCustomerIds: ReadonlyArray<number>;
}): number[] {
  const all = new Set<number>();
  for (const id of input.paymentCustomerIds) all.add(id);
  for (const id of input.ledgerCustomerIds) all.add(id);
  return Array.from(all).sort((a, b) => a - b);
}
