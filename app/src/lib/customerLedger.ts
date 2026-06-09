// /app/src/lib/customerLedger.ts
//
// AR ledger helper (Phase 0.5.2). Owns the atomic append + balance
// derivation for `CustomerLedgerEntry`. Mirrors the proven
// `lib/customerCredit.ts` shape — transaction-wrapped insert + parent
// row update so a partial write can never leave `Customer.openArBalance`
// out of sync with the ledger.
//
// CONTRACT
// --------
//
// 1. `appendEntry()` is the ONLY way to write a CustomerLedgerEntry row in
//    application code. Direct `prisma.customerLedgerEntry.create()` calls
//    bypass the balance bump and break the running-total invariant.
//    (Test fixtures are the documented exception — they seed entries
//    directly and don't rely on the running balance.)
//
// 2. Every append happens inside `prisma.$transaction()`. If either the
//    insert or the customer update fails, the entire append rolls back —
//    no orphan ledger row, no out-of-sync balance.
//
// 3. The signed-amount convention matches `CustomerCreditTransaction`:
//    positive amount → balance INCREASES (sale, deposit received,
//    adjustment-debit). Negative amount → balance DECREASES (payment,
//    refund issued, adjustment-credit, deposit applied to invoice).
//
// 4. `computeRunningBalance()` is a pure function — the canonical
//    re-derivation used by the daily-recon cron and by validation
//    scripts. If `customer.openArBalance` and `computeRunningBalance(
//    customer.ledgerEntries)` ever diverge, something has bypassed
//    `appendEntry()` (or there's a real bug — equally important to
//    surface).
//
// 5. `validateAgainstSource()` cross-checks the ledger-derived balance
//    against the source-of-truth balance computed from
//    `paymentService.computeBalance` over all of a customer's orders.
//    The two MUST agree to within $0.01 (`MICRO_BALANCE_THRESHOLD`).
//    Any drift is a hard error — that's the entire reason this ledger
//    exists, to be reconcilable to source.
//
// USAGE
// -----
//
//   await appendEntry({
//     customerId: 42,
//     type: "PAYMENT",
//     amount: -500,             // payment reduces balance owed
//     reference: "SO-38985 deposit",
//     paymentId: payment.id,
//     createdBy: "stripe-webhook",
//   });
//
// See `__tests__/customerLedger.test.ts` for the full test suite.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type CustomerLedgerEntryType =
  | "SALE"
  | "PAYMENT"
  | "REFUND_ISSUED"
  | "DEPOSIT_RECEIVED"
  | "DEPOSIT_APPLIED"
  | "ADJUSTMENT_DEBIT"
  | "ADJUSTMENT_CREDIT";

/**
 * The minimum shape `appendEntry` needs from a transaction client. Lets
 * callers pass either a `prisma.$transaction()` callback's `tx` or the
 * top-level `prisma` client (in which case the function opens its own
 * transaction). Lifted into a type so tests can construct a typed mock
 * if needed.
 */
type LedgerClient = Pick<Prisma.TransactionClient, "customer" | "customerLedgerEntry">;

export interface AppendEntryInput {
  customerId: number;
  type: CustomerLedgerEntryType;
  /**
   * Signed amount. Positive = balance increases (sale, deposit-received,
   * adjustment-debit). Negative = balance decreases (payment,
   * refund-issued, deposit-applied, adjustment-credit).
   */
  amount: number;
  salesOrderId?: number;
  paymentId?: number;
  invoiceId?: number;
  reference?: string;
  notes?: string;
  createdBy?: string;
}

export interface LedgerEntrySummary {
  id: number;
  customerId: number;
  type: CustomerLedgerEntryType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  salesOrderId: number | null;
  paymentId: number | null;
  invoiceId: number | null;
  reference: string | null;
  notes: string | null;
  created: Date;
}

/** Half-cent tolerance — same value used by paymentService + journalEntry. */
export const LEDGER_TOLERANCE = 0.005;

/**
 * Round to 2 decimal places. Local copy to avoid pulling money.ts which
 * has its own toolchain costs in test bundles.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Append a new ledger entry AND atomically bump
 * `Customer.openArBalance` to the new balance.
 *
 * Opens a transaction if not handed one. Callers that already hold a
 * `prisma.$transaction()` should pass `tx` so all writes commit
 * atomically with whatever else they're doing (e.g. the payment-record
 * flow writes the Payment row, the ledger entry, and the balance bump
 * in one transaction).
 */
export async function appendEntry(
  input: AppendEntryInput,
  tx?: LedgerClient,
): Promise<LedgerEntrySummary> {
  if (!Number.isFinite(input.amount)) {
    // TypeError because the value's type/shape is invalid (NaN /
    // Infinity), not a domain error. S7786.
    throw new TypeError(`appendEntry: amount must be finite, got ${input.amount}`);
  }
  const amount = round2(input.amount);
  if (amount === 0) {
    throw new Error(
      `appendEntry: amount must be non-zero (zero-amount rows are noise, ` +
        `they would still pass balance assertions but break drill-down)`,
    );
  }

  const exec = async (client: LedgerClient): Promise<LedgerEntrySummary> => {
    const customer = await client.customer.findUniqueOrThrow({
      where: { id: input.customerId },
      select: { openArBalance: true },
    });
    const balanceBefore = round2(Number(customer.openArBalance ?? 0));
    const balanceAfter = round2(balanceBefore + amount);

    const row = await client.customerLedgerEntry.create({
      data: {
        customerId: input.customerId,
        type: input.type,
        amount,
        balanceBefore,
        balanceAfter,
        salesOrderId: input.salesOrderId,
        paymentId: input.paymentId,
        invoiceId: input.invoiceId,
        reference: input.reference,
        notes: input.notes,
        createdBy: input.createdBy,
      },
    });

    await client.customer.update({
      where: { id: input.customerId },
      data: { openArBalance: balanceAfter },
    });

    return {
      id: row.id,
      customerId: row.customerId,
      type: row.type as CustomerLedgerEntryType,
      amount: Number(row.amount),
      balanceBefore: Number(row.balanceBefore),
      balanceAfter: Number(row.balanceAfter),
      salesOrderId: row.salesOrderId,
      paymentId: row.paymentId,
      invoiceId: row.invoiceId,
      reference: row.reference,
      notes: row.notes,
      created: row.created,
    };
  };

  if (tx) return exec(tx);
  return prisma.$transaction(exec);
}

/**
 * Pure: re-derive a customer's running balance from a chronologically
 * ordered list of ledger entries. Returns the final balance plus the
 * post-balance after each entry, useful for the daily-recon cron's
 * "show me where it diverged" output.
 *
 * Entries should already be in `created ASC` order. The caller is
 * responsible for ordering — we don't sort here because the upstream
 * Prisma query is the source of truth for ordering (and re-sorting
 * would mask bugs where two entries have the same `created` timestamp
 * but were written in a meaningful sequence).
 */
export function computeRunningBalance(entries: ReadonlyArray<{ amount: number | string }>): {
  balance: number;
  perEntry: number[];
} {
  const perEntry: number[] = [];
  let balance = 0;
  for (const e of entries) {
    balance = round2(balance + Number(e.amount));
    perEntry.push(balance);
  }
  return { balance, perEntry };
}

/**
 * Pure: validate that a ledger-derived balance agrees with a source-of-
 * truth balance computed independently (typically via
 * `paymentService.computeBalance` summed across all the customer's
 * orders). Used by:
 *   - the daily-recon cron — flag any customer where ledger != source
 *   - the Phase 0.5.7 validation script — assert all 20 hand-picked
 *     customers reconcile before declaring the ledger cutover-ready
 *
 * Returns `ok: true` when the two agree to within `LEDGER_TOLERANCE`
 * (half a cent). Returns `ok: false` with the diff and a diagnostic
 * message otherwise. Never throws — callers can choose whether to
 * alert, log, or fail.
 */
export interface LedgerValidation {
  ok: boolean;
  ledgerBalance: number;
  sourceBalance: number;
  diff: number;
  message?: string;
}

export function validateAgainstSource(
  ledgerBalance: number,
  sourceBalance: number,
): LedgerValidation {
  const ledger = round2(ledgerBalance);
  const source = round2(sourceBalance);
  const diff = round2(ledger - source);
  if (Math.abs(diff) <= LEDGER_TOLERANCE) {
    return { ok: true, ledgerBalance: ledger, sourceBalance: source, diff };
  }
  return {
    ok: false,
    ledgerBalance: ledger,
    sourceBalance: source,
    diff,
    message:
      `Ledger out of sync with source: ledger=${ledger.toFixed(2)}, ` +
      `source=${source.toFixed(2)}, diff=${diff.toFixed(2)}. Investigate ` +
      `whether (a) appendEntry() was bypassed, (b) a payment was VOIDED ` +
      `after a ledger entry was written, or (c) the import pipeline ` +
      `created a SalesOrder/Payment without an accompanying ledger entry.`,
  };
}

/**
 * Resolve the sign convention for a given entry type. Useful for
 * callers that compute an entry's amount from a positive event amount
 * and want the helper to apply the right sign — keeps the convention
 * documented in code rather than scattered across call sites.
 *
 * Sign convention: positive amount INCREASES `Customer.openArBalance`
 * (customer owes us more), negative amount DECREASES it.
 *
 *   +1: SALE — customer purchased something, owes us more
 *   +1: DEPOSIT_RECEIVED — pre-invoice cash held; conceptually an
 *       offsetting debit to the customer that nets when invoicing
 *       happens (mirrors the SOR plan's deposit model)
 *   +1: REFUND_ISSUED — we paid customer back; the prior payment is
 *       reversed so balance returns to whatever the underlying sale
 *       still requires. Mirrors `paymentService.computeBalance`'s
 *       refund handling: refunds SUBTRACT from totalPaid (= ADD to
 *       balanceDue).
 *   +1: ADJUSTMENT_DEBIT — manager-entered correction, debit side
 *   -1: PAYMENT — customer paid; balance owed decreases
 *   -1: DEPOSIT_APPLIED — held deposit applied against an invoice
 *   -1: ADJUSTMENT_CREDIT — manager-entered correction, credit side
 */
export function signForType(type: CustomerLedgerEntryType): 1 | -1 {
  switch (type) {
    case "SALE":
    case "DEPOSIT_RECEIVED":
    case "REFUND_ISSUED":
    case "ADJUSTMENT_DEBIT":
      return 1;
    case "PAYMENT":
    case "DEPOSIT_APPLIED":
    case "ADJUSTMENT_CREDIT":
      return -1;
  }
}

/**
 * Compute a customer's source-of-truth AR balance from their orders +
 * line items + payments. Mirrors `paymentService.computeBalance` but
 * sums across ALL of a customer's orders rather than per-order, and
 * does NOT apply the micro-balance snap-to-zero (the ledger needs
 * exact values). Used by:
 *
 *   - The backfill job (Phase 0.5.3) to compute a customer's balance
 *     from raw data and reconcile against the running-sum ledger.
 *   - The daily-recon cron (Phase 0.5.5) to detect drift between the
 *     stored `Customer.openArBalance` and what the source data says.
 *
 * Filters mirror `computeBalance`: lineItemStatus='CANCELLED' lines
 * are excluded; payments with status VOIDED/FAILED are excluded;
 * isRefund=true payments SUBTRACT from totalPaid (= ADD to balanceDue).
 *
 * Returns 0 if the customer has no orders. Pure-helper-friendly: the
 * caller passes pre-loaded data (no DB access here), so the function
 * is testable in isolation and works inside any Prisma transaction.
 */
// netPrice/vatAmount/paymentAmount fields are typed as `unknown`
// because the underlying value can be a Prisma Decimal, a number, or
// a string depending on the call site (production code passes
// Decimals; tests pass plain numbers). `Number()` coerces all three.
// We DON'T import Prisma types here to keep this file usable from a
// script context that doesn't have the full Prisma client loaded.
export interface OrderForLedgerSource {
  lineItems: ReadonlyArray<{
    netPrice: unknown;
    vatAmount: unknown;
    lineItemStatus: string;
  }>;
  payments: ReadonlyArray<{
    paymentAmount: unknown;
    isRefund: boolean;
    status: string | null;
  }>;
}

const EXCLUDED_PAYMENT_STATUSES = new Set(["VOIDED", "FAILED"]);

export function computeSourceBalance(orders: ReadonlyArray<OrderForLedgerSource>): number {
  let total = 0;
  for (const o of orders) {
    let due = 0;
    for (const li of o.lineItems) {
      if (li.lineItemStatus === "CANCELLED") continue;
      due += Number(li.netPrice) + Number(li.vatAmount ?? 0);
    }
    let paid = 0;
    for (const p of o.payments) {
      if (p.status && EXCLUDED_PAYMENT_STATUSES.has(p.status)) continue;
      const amt = Number(p.paymentAmount);
      paid += p.isRefund ? -Math.abs(amt) : amt;
    }
    total += due - paid;
  }
  return round2(total);
}
