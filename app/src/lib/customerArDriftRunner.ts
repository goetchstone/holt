// /app/src/lib/customerArDriftRunner.ts
//
// Phase 0.5.5 — orchestration runner for the customer AR-drift check.
//
// Hydrates customers with recent activity, recomputes their source-of-
// truth balance, and compares against the stored running total. Pure of
// HTTP/auth/logging concerns — the API handler is a thin wrapper.
//
// Extracted from the handler per CLAUDE.md rule 14 (test the logic, not
// the wrapper) so the orchestration can be exercised against real
// Postgres via the standard integration-test harness.

import { prisma } from "@/lib/prisma";
import {
  compareCustomerArBalances,
  selectCustomersForCheck,
  type ArDriftReport,
  type CustomerArInput,
} from "@/lib/customerArDrift";
import type { OrderForLedgerSource } from "@/lib/customerLedger";
import { computeStandaloneInvoiceSource } from "@/lib/billing/invoiceAuthoring";

export const DEFAULT_LOOKBACK_HOURS = 26; // 1am cron covers the prior day

export interface RunDriftCheckInput {
  /** Hours back from now to scan for recent payment / ledger activity.
   *  Ignored when `customerIds` is provided. */
  lookbackHours?: number;
  /** Phase 0.5.7 (2026-05-13) — hand-pick mode. When provided, the
   *  runner skips the activity-window query entirely and checks ONLY
   *  these ids. Used by the cutover-readiness validation pass: the
   *  admin picks 20 representative customers (long-time regulars,
   *  customers with deposits, customers with refund chains, etc.) and
   *  cross-checks each one against the POS's reported balance. Empty
   *  array short-circuits to an empty report (rather than falling
   *  through to lookback mode and accidentally walking thousands of
   *  customers). */
  customerIds?: ReadonlyArray<number>;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export type DriftCheckMode = "lookback" | "hand-picked";

export interface RunDriftCheckResult extends ArDriftReport {
  runAt: string;
  /** Which selection mode produced the `checked` set. */
  mode: DriftCheckMode;
  /** Only set in lookback mode. Null in hand-picked mode. */
  lookbackHours: number | null;
}

/**
 * Run the AR-drift check end-to-end.
 *
 * Two modes:
 *   lookback     — find customers with payment OR ledger activity in
 *                  the last `lookbackHours` (daily cron default)
 *   hand-picked  — use the explicit `customerIds` list (Phase 0.5.7
 *                  cutover-validation pass)
 *
 * In both modes:
 *   1. Resolve candidate ids
 *   2. Hydrate orders + payments for those customers
 *   3. Pass through the pure compare helper
 */
export async function runCustomerArDriftCheck(
  input: RunDriftCheckInput = {},
): Promise<RunDriftCheckResult> {
  const now = input.now ?? new Date();
  const handPicked = Array.isArray(input.customerIds);
  const mode: DriftCheckMode = handPicked ? "hand-picked" : "lookback";
  const lookbackHours = handPicked ? null : (input.lookbackHours ?? DEFAULT_LOOKBACK_HOURS);

  // 1) Resolve the candidate id set per mode.
  let candidateIds: number[];
  if (handPicked) {
    // Dedup + sort the caller-provided ids. Skip non-finite / non-positive.
    candidateIds = Array.from(
      new Set((input.customerIds ?? []).filter((id) => Number.isInteger(id) && id > 0)),
    ).sort((a, b) => a - b);
  } else {
    const since = new Date(now.getTime() - (lookbackHours as number) * 60 * 60 * 1000);
    const recentPayments = await prisma.payment.findMany({
      where: { created: { gte: since }, customerId: { not: null } },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    const recentLedger = await prisma.customerLedgerEntry.findMany({
      where: { created: { gte: since } },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    candidateIds = selectCustomersForCheck({
      paymentCustomerIds: recentPayments
        .map((p) => p.customerId)
        .filter((id): id is number => id !== null),
      ledgerCustomerIds: recentLedger.map((e) => e.customerId),
    });
  }

  if (candidateIds.length === 0) {
    return {
      runAt: now.toISOString(),
      mode,
      lookbackHours,
      checked: 0,
      ok: 0,
      drifted: [],
      totalAbsoluteDrift: 0,
    };
  }

  // 2) Hydrate candidates + their orders. Single bulk query per side;
  //    group in JS. For ~100 candidate customers per day this is fast.
  const customers = await prisma.customer.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      openArBalance: true,
    },
  });

  const ordersForCustomers = await prisma.salesOrder.findMany({
    where: {
      customerId: { in: candidateIds },
      status: { not: "CANCELLED" },
    },
    select: {
      customerId: true,
      lineItems: {
        select: { netPrice: true, vatAmount: true, lineItemStatus: true },
      },
      payments: {
        select: { paymentAmount: true, isRefund: true, status: true },
      },
    },
  });

  // 2b) Authored standalone invoices (no SalesOrder behind them) recognize
  //     AR through the invoice flow — fold their balances into the source
  //     side so billed customers tie out. Payments come via the structural
  //     Payment.invoiceId binding at their FULL amounts (mirroring the
  //     ledger), so an overpayment surplus still reconciles.
  // All statuses on purpose: a stale-link payment can land on a VOID invoice
  // (journal + ledger posted, nothing applied) — its payment must still count
  // on the source side. computeStandaloneInvoiceSource filters the due side
  // to ISSUED/PAID itself.
  const invoicesForCustomers = await prisma.invoice.findMany({
    where: {
      customerId: { in: candidateIds },
      organizationId: { not: null },
    },
    select: {
      customerId: true,
      status: true,
      total: true,
      payments: { select: { paymentAmount: true, status: true, isRefund: true } },
    },
  });
  const invoiceBalanceMap = new Map<number, number>();
  {
    const grouped = new Map<
      number,
      {
        invoices: { status: string; total: number }[];
        payments: { paymentAmount: number; status: string | null; isRefund: boolean }[];
      }
    >();
    for (const inv of invoicesForCustomers) {
      if (inv.customerId === null || inv.total === null) continue;
      const bucket = grouped.get(inv.customerId) ?? { invoices: [], payments: [] };
      bucket.invoices.push({ status: String(inv.status), total: Number(inv.total) });
      for (const pay of inv.payments) {
        bucket.payments.push({
          paymentAmount: Number(pay.paymentAmount),
          status: pay.status ? String(pay.status) : null,
          isRefund: pay.isRefund,
        });
      }
      grouped.set(inv.customerId, bucket);
    }
    for (const [customerId, b] of grouped) {
      invoiceBalanceMap.set(customerId, computeStandaloneInvoiceSource(b.invoices, b.payments));
    }
  }

  // 3) Group orders by customerId.
  const ordersMap = new Map<number, OrderForLedgerSource[]>();
  for (const o of ordersForCustomers) {
    if (o.customerId === null) continue;
    const list = ordersMap.get(o.customerId) ?? [];
    list.push({
      lineItems: o.lineItems.map((li) => ({
        netPrice: li.netPrice,
        vatAmount: li.vatAmount,
        lineItemStatus: li.lineItemStatus ?? "ACTIVE",
      })),
      payments: o.payments.map((p) => ({
        paymentAmount: p.paymentAmount,
        isRefund: p.isRefund,
        status: p.status,
      })),
    });
    ordersMap.set(o.customerId, list);
  }

  // 4) Build inputs + compare.
  const inputs: CustomerArInput[] = customers.map((c) => ({
    customerId: c.id,
    label: buildCustomerLabel(c.firstName, c.lastName, c.id),
    storedBalance: Number(c.openArBalance ?? 0),
    orders: ordersMap.get(c.id) ?? [],
    standaloneInvoiceBalance: invoiceBalanceMap.get(c.id) ?? 0,
  }));

  return {
    runAt: now.toISOString(),
    mode,
    lookbackHours,
    ...compareCustomerArBalances(inputs),
  };
}

/**
 * Build a privacy-respectful label for the drift report (last name +
 * first initial). Falls back to id when names are missing.
 */
export function buildCustomerLabel(
  firstName: string | null,
  lastName: string | null,
  id: number,
): string {
  const ln = (lastName ?? "").trim();
  const fn = (firstName ?? "").trim();
  if (ln && fn) return `${ln}, ${fn.charAt(0)}.`;
  if (ln) return ln;
  if (fn) return fn;
  return `Customer #${id}`;
}
