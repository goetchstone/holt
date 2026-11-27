// /app/src/lib/customerLedgerBackfill.ts
//
// Phase 0.5.3 — backfill the CustomerLedgerEntry table from existing
// SalesOrder + OrderLineItem + Payment data.
//
// CONTRACT
// --------
//
// 1. **Idempotent.** Running on a customer who already has ledger
//    entries is a no-op. Re-running across the whole DB after the first
//    pass should produce zero new rows. This lets us run incrementally
//    (catch new customers since the last pass) without bookkeeping.
//
// 2. **Reconciles to source on every run, BUT does not throw on drift.**
//    Per user direction 2026-05-07: "We do what is possible while we
//    are not the system of record, and ensure we can be once we take
//    over." While the POS is still SOR, imported data has known
//    inconsistencies (orphaned refunds, missing rewrite linkages, gift
//    card sales never imported). The backfill commits its ledger
//    entries either way and TAGS each customer's result with whether
//    the ledger reconciled to source. Drifted customers are surfaced
//    in the aggregate run result so the operator can review without
//    losing the rest of the backfill. Once we cut over to SOR (Phase
//    1) the reconciliation can be tightened to throw — we'll own the
//    source data and any drift is a real bug.
//
//    The "source" here is `paymentService.computeBalance` summed
//    across the customer's orders — i.e., OUR view of the data after
//    all the import-runner fixes. That catches event-classification
//    bugs in this backfill but won't catch import-side bugs (the
//    ledger and OUR balance both diverge from the POS the same way).
//    Phase 0.5.7's validation pass will add a SECOND reconciliation
//    against the POS's `Customer_Deposits_Export.csv` (`Dueamount`
//    column) — that gives us a third opinion. THREE views: ledger,
//    our computeBalance, the POS's report. In the happy case all
//    three agree. When they don't, neither side is the unconditional
//    truth — the POS has produced wrong numbers before (phantom
//    Gift Card payments on rewrites, daily-by-store mismatches, the
//    rewrite-chain orphan-cancel saga). The validator's job is to FLAG drift and let
//    the operator arbitrate, not to auto-correct one source to match
//    another.
//
// 3. **Bypasses appendEntry().** The forward-flow `appendEntry()` reads
//    the customer's current balance, computes balanceBefore/After,
//    writes one row, updates Customer.openArBalance — a query + insert
//    + update per event. For a backfill of thousands of customers ×
//    several events each, that's hundreds of thousands of DB calls. The
//    backfill instead computes the full chronological run in JS and
//    writes all entries in one createMany.
//    Trades the per-row safety net (rule 12) for speed; the
//    reconciliation step at the end is the safety net at the customer
//    level instead of per-event.
//
// 4. **Skips empty customers.** Customers with zero orders get nothing
//    written — their openArBalance stays at the default 0.
//
// EVENT SOURCING
// --------------
//
// For each customer, we walk three event types in chronological order
// (`created` timestamp on the source row):
//
//   - SALE: one entry per non-CANCELLED SalesOrder, amount = sum of
//     (netPrice + vatAmount) over its non-CANCELLED line items. Sign
//     follows the line items naturally — return orders (accounting-return)
//     have negative line items and emit a negative-amount SALE entry.
//
//   - PAYMENT: one entry per Payment that is money in hand (not VOIDED,
//     FAILED or PENDING; lib/paymentBalance.ts) with isRefund=false. Amount = -paymentAmount (customer paid → balance
//     decreases).
//
//   - REFUND_ISSUED: one entry per such Payment with
//     isRefund=true. Amount = +|paymentAmount| (we paid customer back →
//     balance climbs back up; mirrors computeBalance's refund handling).
//
// This mirrors `paymentService.computeBalance` exactly — same filters,
// same sign conventions — which is why the reconciliation check passes
// for every customer with clean data.
//
// CHRONOLOGICAL ORDERING
// ----------------------
//
// We sort by the `created` timestamp on the source row, NOT by
// `orderDate` or `paymentDate`. Reason: orderDate / paymentDate are
// user-set fields that can be backdated (a manager closing a deal next
// week with this week's date). `created` is the actual write time,
// monotonic per the DB clock, and matches the order in which the
// runner saw the events. Ties (same millisecond) fall back to the
// row id so the ordering is deterministic.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  computeSourceBalance,
  lockCustomerForLedger,
  validateAgainstSource,
  type LedgerValidation,
} from "@/lib/customerLedger";
import { isPaymentExcludedFromBalance } from "@/lib/paymentBalance";
import { isCountedLine, isRevenueStatus } from "@/lib/salesOrderRevenue";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BackfillResult {
  customerId: number;
  status:
    | "skipped-already-backfilled"
    | "skipped-no-orders"
    | "backfilled"
    | "backfilled-with-drift"
    /**
     * The customer has ledger entries the backfill did not write (a payment
     * taken before it ran) and none of its own. Nothing is written: the
     * history is not there, and `validation` says how far the stored balance
     * is from what the orders and payments say.
     */
    | "needs-review-forward-entries";
  entriesCreated: number;
  finalBalance: number;
  validation: LedgerValidation;
}

interface OrderRow {
  id: number;
  orderno: string;
  orderDate: Date | null;
  status: string;
  created: Date;
  lineItems: Array<{
    netPrice: Prisma.Decimal | number;
    vatAmount: Prisma.Decimal | number | null;
    lineItemStatus: string;
  }>;
  payments: Array<{
    id: number;
    paymentAmount: Prisma.Decimal | number;
    isRefund: boolean;
    status: string | null;
    paymentCode: string | null;
    paymentDate: Date | null;
    created: Date;
  }>;
}

interface BackfillEvent {
  ts: Date;
  rowId: number;
  type: "SALE" | "PAYMENT" | "REFUND_ISSUED";
  amount: number;
  salesOrderId: number;
  paymentId?: number;
  reference: string;
}

const BACKFILL_CREATED_BY = "ledger-backfill-2026-05-07";

/**
 * Build the chronological event list for a single customer's orders.
 * Pure: no DB access, takes pre-loaded data and returns sorted events.
 * Exported for testability.
 */
/**
 * Compute the SALE amount for an order = sum of (netPrice + vatAmount)
 * over its counted line items (not cancelled or replaced, COUNTED_LINE_STATUSES). Only a sale is
 * owed (SALES_REVENUE_STATUSES): a quote is not, and neither is a cancelled order. It used to skip
 * only CANCELLED, so every open quote was backfilled as money owed. Returns 0 if there's no active
 * line; the caller then skips the SALE event entirely.
 */
function computeSaleAmount(order: OrderRow): number {
  if (!isRevenueStatus(order.status)) return 0;
  let saleAmount = 0;
  for (const li of order.lineItems) {
    if (!isCountedLine(li.lineItemStatus)) continue;
    saleAmount += Number(li.netPrice) + Number(li.vatAmount ?? 0);
  }
  return round2(saleAmount);
}

/**
 * Build PAYMENT / REFUND_ISSUED events from one order's payments.
 * Leaves out VOIDED, FAILED and PENDING (isPaymentExcludedFromBalance, the
 * one list every balance reads) and zero-amount rows. PENDING used to be
 * ledgered: a payment link nobody had paid yet was written as money received,
 * and stayed so if the link was later voided. Sign convention is handled here
 * so the caller stays a flat loop.
 */
function buildPaymentEvents(order: OrderRow): BackfillEvent[] {
  const events: BackfillEvent[] = [];
  for (const p of order.payments) {
    if (isPaymentExcludedFromBalance(p.status)) continue;
    const amt = Number(p.paymentAmount);
    if (amt === 0) continue;
    // Sign: PAYMENT decreases balance owed, REFUND_ISSUED increases it.
    // See signForType in customerLedger.ts for the full convention.
    const signedAmount = round2(p.isRefund ? Math.abs(amt) : -amt);
    events.push({
      ts: p.created,
      rowId: p.id,
      type: p.isRefund ? "REFUND_ISSUED" : "PAYMENT",
      amount: signedAmount,
      salesOrderId: order.id,
      paymentId: p.id,
      reference: p.paymentCode || order.orderno,
    });
  }
  return events;
}

export function buildBackfillEvents(orders: OrderRow[]): BackfillEvent[] {
  const events: BackfillEvent[] = [];

  for (const o of orders) {
    const saleAmount = computeSaleAmount(o);
    if (saleAmount !== 0) {
      events.push({
        ts: o.created,
        rowId: o.id,
        type: "SALE",
        amount: saleAmount,
        salesOrderId: o.id,
        reference: o.orderno,
      });
    }
    events.push(...buildPaymentEvents(o));
  }

  // Chronological sort. Stable tiebreak on rowId so identical
  // timestamps still order deterministically — important for tests
  // that seed multiple events at the same millisecond.
  events.sort((a, b) => {
    const tsDiff = a.ts.getTime() - b.ts.getTime();
    if (tsDiff !== 0) return tsDiff;
    return a.rowId - b.rowId;
  });

  return events;
}

/**
 * Backfill ledger entries for a single customer, idempotently.
 *
 * Wraps everything in one transaction: the existing-entries check, the
 * orders/payments load, the createMany, the Customer.openArBalance
 * update, and the source-of-truth reconciliation. If any step throws,
 * nothing persists.
 */
export async function backfillCustomerLedger(customerId: number): Promise<BackfillResult> {
  return prisma.$transaction(async (tx) => {
    // 0. The customer's row, for the whole backfill (lockCustomerForLedger).
    // Two backfills of one customer at once each counted no entries and each
    // wrote the whole history; a payment landing mid-backfill was overwritten
    // by the total written at the end.
    await lockCustomerForLedger(tx, customerId);

    // 1. Idempotency: skip a customer this backfill has already written. Only
    // its own rows say that. "Any entry exists" also skipped a customer whose
    // one entry was a payment taken before the backfill ran, reported them as
    // clean, and left their history out for good.
    const own = await tx.customerLedgerEntry.count({
      where: { customerId, createdBy: BACKFILL_CREATED_BY },
    });
    if (own > 0) {
      const cust = await tx.customer.findUnique({
        where: { id: customerId },
        select: { openArBalance: true },
      });
      const balance = round2(Number(cust?.openArBalance ?? 0));
      return {
        customerId,
        status: "skipped-already-backfilled",
        entriesCreated: 0,
        finalBalance: balance,
        validation: {
          ok: true,
          ledgerBalance: balance,
          sourceBalance: balance,
          diff: 0,
        },
      };
    }
    const forward = await tx.customerLedgerEntry.count({ where: { customerId } });

    // 2. Load all of the customer's orders + payments + line items.
    const orders = await tx.salesOrder.findMany({
      where: { customerId },
      select: {
        id: true,
        orderno: true,
        orderDate: true,
        status: true,
        created: true,
        lineItems: {
          select: {
            netPrice: true,
            vatAmount: true,
            lineItemStatus: true,
          },
        },
        payments: {
          select: {
            id: true,
            paymentAmount: true,
            isRefund: true,
            status: true,
            paymentCode: true,
            paymentDate: true,
            created: true,
          },
        },
      },
    });

    // 2b. Entries exist that this backfill did not write. Writing the history
    // around them would double whatever they already cover, so nothing is
    // written. The customer is handed back for a person to look at, with the
    // gap between the stored balance and what the orders and payments say.
    if (forward > 0) {
      const cust = await tx.customer.findUnique({
        where: { id: customerId },
        select: { openArBalance: true },
      });
      const stored = round2(Number(cust?.openArBalance ?? 0));
      return {
        customerId,
        status: "needs-review-forward-entries",
        entriesCreated: 0,
        finalBalance: stored,
        validation: validateAgainstSource(stored, computeSourceBalance(orders as OrderRow[])),
      };
    }

    if (orders.length === 0) {
      return {
        customerId,
        status: "skipped-no-orders",
        entriesCreated: 0,
        finalBalance: 0,
        validation: { ok: true, ledgerBalance: 0, sourceBalance: 0, diff: 0 },
      };
    }

    // 3. Build the chronological event list and walk the running balance.
    const events = buildBackfillEvents(orders as OrderRow[]);
    let balance = 0;
    const ledgerRows: Prisma.CustomerLedgerEntryCreateManyInput[] = [];
    for (const e of events) {
      const balanceBefore = balance;
      balance = round2(balance + e.amount);
      ledgerRows.push({
        customerId,
        type: e.type,
        amount: e.amount,
        balanceBefore,
        balanceAfter: balance,
        salesOrderId: e.salesOrderId,
        paymentId: e.paymentId,
        reference: e.reference,
        createdBy: BACKFILL_CREATED_BY,
        // The `created` timestamp on each ledger row preserves the
        // event's actual time so reports / drill-downs can reconstruct
        // the ordering. Without this, all rows would carry the
        // backfill's wall-clock and the ledger would lose history.
        created: e.ts,
      });
    }

    if (ledgerRows.length > 0) {
      await tx.customerLedgerEntry.createMany({ data: ledgerRows });
    }

    // 4. Update the customer's stored running balance.
    await tx.customer.update({
      where: { id: customerId },
      data: { openArBalance: balance },
    });

    // 5. Reconcile against the source-of-truth balance computed directly
    // from the order/payment data. Drift means the ledger sum disagrees
    // with what `paymentService.computeBalance` would say — could be an
    // event-type misclassification, a sign flip, OR (more likely while
    // we're not SOR) imported-data inconsistencies (orphaned refunds
    // without originalPaymentId, etc.).
    //
    // We DO NOT throw on drift. Per the user's 2026-05-07 directive,
    // we ship the ledger entries and tag the customer's status as
    // "backfilled-with-drift" so the operator can review the drifted
    // list. Once we own the source (Phase 1 cutover), this can switch
    // to throw — any drift then is a real bug.
    const sourceBalance = computeSourceBalance(orders as OrderRow[]);
    const validation = validateAgainstSource(balance, sourceBalance);

    return {
      customerId,
      status: validation.ok ? "backfilled" : "backfilled-with-drift",
      entriesCreated: ledgerRows.length,
      finalBalance: balance,
      validation,
    };
  });
}

export interface BackfillRunResult {
  customersTotal: number;
  customersBackfilled: number;
  customersBackfilledWithDrift: number;
  customersSkipped: number;
  /** Customers with entries the backfill did not write and none of its own: nothing written. */
  customersNeedingReview: number;
  customersFailed: number;
  entriesCreated: number;
  totalDriftDollars: number;
  /** Customers whose ledger drifted from source. Operator should review. */
  driftedCustomers: Array<{
    customerId: number;
    ledgerBalance: number;
    sourceBalance: number;
    diff: number;
  }>;
  errors: Array<{ customerId: number; message: string }>;
}

/** Add one customer's outcome to the run's totals. */
function tally(result: BackfillRunResult, r: BackfillResult): void {
  result.entriesCreated += r.entriesCreated;
  if (r.status === "backfilled") {
    result.customersBackfilled++;
    return;
  }
  if (r.status === "skipped-already-backfilled" || r.status === "skipped-no-orders") {
    result.customersSkipped++;
    return;
  }
  if (r.status === "backfilled-with-drift") result.customersBackfilledWithDrift++;
  else result.customersNeedingReview++;
  // A customer needing review is listed whatever the gap, so they are never
  // read as done; one that happens to tie out shows a diff of 0.
  result.totalDriftDollars = round2(result.totalDriftDollars + Math.abs(r.validation.diff));
  result.driftedCustomers.push({
    customerId: r.customerId,
    ledgerBalance: r.validation.ledgerBalance,
    sourceBalance: r.validation.sourceBalance,
    diff: r.validation.diff,
  });
}

/**
 * Backfill ledger for every customer in the database, in batches.
 *
 * Each customer is its own transaction (per `backfillCustomerLedger`)
 * so a single bad customer doesn't poison the whole run. Failed
 * customers are logged in `errors` with their id and the exception
 * message; the run continues with the next customer. Operator can
 * inspect the failed list, fix the underlying data, and re-run —
 * idempotency skips successfully-backfilled customers.
 */
export async function backfillAllCustomers(
  opts: {
    batchSize?: number;
    customerIds?: number[];
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<BackfillRunResult> {
  const result: BackfillRunResult = {
    customersTotal: 0,
    customersBackfilled: 0,
    customersBackfilledWithDrift: 0,
    customersSkipped: 0,
    customersNeedingReview: 0,
    customersFailed: 0,
    entriesCreated: 0,
    totalDriftDollars: 0,
    driftedCustomers: [],
    errors: [],
  };

  // Resolve the set of customers to backfill.
  const ids =
    opts.customerIds ??
    (await prisma.customer.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
      (c) => c.id,
    );
  result.customersTotal = ids.length;

  for (const id of ids) {
    try {
      tally(result, await backfillCustomerLedger(id));
    } catch (err) {
      result.customersFailed++;
      result.errors.push({
        customerId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (opts.onProgress) {
      opts.onProgress(
        result.customersBackfilled +
          result.customersBackfilledWithDrift +
          result.customersSkipped +
          result.customersNeedingReview +
          result.customersFailed,
        result.customersTotal,
      );
    }
  }

  return result;
}
