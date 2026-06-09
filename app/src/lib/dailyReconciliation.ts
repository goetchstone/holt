// /app/src/lib/dailyReconciliation.ts
//
// Phase 0 control C1 (pivoted 2026-04-28): cross-checks our generated
// JournalEntry for a given date against the underlying source data
// (OrderLineItem totals + Payment totals). Drift indicates either a
// JE-generator bug or a data-quality issue with our operational data.
//
// IMPORTANT framing: this is NOT "do the books balance" -- the books of
// record live in QuickBooks, not here. This is "does our generated JE
// accurately reflect our source data so the accountant can trust the
// import?" Drift > $0.01 means the JE we hand QB will misrepresent
// what actually happened.
//
// Trigger model: invoked manually (button on the JE detail page)
// rather than by cron. The accountant runs the JE one day at a time
// and validates before exporting; that's the workflow integration
// where this check is most actionable. Cron deferred (no consistent
// "today's JE exists" moment to schedule against).

import type { Prisma, PrismaClient } from "@prisma/client";

export const RECONCILIATION_TOLERANCE = 0.01;

export interface DailyReconciliationSource {
  /** Sum of OrderLineItem.netPrice for non-cancelled lines on the day's
   * non-cancelled / fulfilled / returned orders. The "what was sold." */
  revenue: number;
  /** Sum of OrderLineItem.vatAmount under the same filter. The
   * "what tax did we collect (or refund)." */
  tax: number;
  /** Sum of OrderLineItem.cost under the same filter. The
   * "what was the cost of goods that moved (in or out via returns)." */
  cost: number;
  /** Sum of Payment.paymentAmount for COMPLETED payments on the day,
   * positive for sales, negative for refunds. The "net cash today." */
  cash: number;
}

export interface DailyReconciliationJournal {
  /** Sum of credits − debits on revenue GL accounts (4-XXXX) in the day's
   * POSTED/EXPORTED JE. Positive = net revenue credited (normal sale day). */
  revenue: number;
  /** Same shape for tax accounts. The TaxDistrict GL is identified
   * via the order's taxGlId; we approximate by GL code prefix 2-2120. */
  tax: number;
  /** Sum of debits − credits on COGS GL accounts (5-52XX). Positive =
   * net expense recognized (normal sale day). */
  cost: number;
  /** Sum of debits − credits on cash GL (1-1006). Positive = net cash in. */
  cash: number;
}

export interface DailyReconciliationDrift {
  revenue: number;
  tax: number;
  cost: number;
  cash: number;
}

export interface DailyReconciliationResult {
  date: string; // YYYY-MM-DD
  hasJournalEntry: boolean;
  journalEntryId: number | null;
  journalStatus: string | null;
  source: DailyReconciliationSource;
  journal: DailyReconciliationJournal;
  drift: DailyReconciliationDrift;
  balanced: boolean;
  warnings: string[];
}

/**
 * Pure comparator: given pre-computed source + journal totals, returns
 * the drift + balanced flag + per-category warnings. Tested in
 * isolation. The DB-touching wrapper computeDailyReconciliation()
 * passes its query results into this.
 */
export function compareReconciliation(
  source: DailyReconciliationSource,
  journal: DailyReconciliationJournal,
  tolerance: number = RECONCILIATION_TOLERANCE,
): { drift: DailyReconciliationDrift; balanced: boolean; warnings: string[] } {
  const drift: DailyReconciliationDrift = {
    revenue: round2(source.revenue - journal.revenue),
    tax: round2(source.tax - journal.tax),
    cost: round2(source.cost - journal.cost),
    cash: round2(source.cash - journal.cash),
  };

  const warnings: string[] = [];
  if (Math.abs(drift.revenue) > tolerance) {
    warnings.push(
      `Revenue drift $${drift.revenue.toFixed(2)} (source ${source.revenue.toFixed(2)} vs journal ${journal.revenue.toFixed(2)})`,
    );
  }
  if (Math.abs(drift.tax) > tolerance) {
    warnings.push(
      `Tax drift $${drift.tax.toFixed(2)} (source ${source.tax.toFixed(2)} vs journal ${journal.tax.toFixed(2)})`,
    );
  }
  if (Math.abs(drift.cost) > tolerance) {
    warnings.push(
      `Cost drift $${drift.cost.toFixed(2)} (source ${source.cost.toFixed(2)} vs journal ${journal.cost.toFixed(2)})`,
    );
  }
  if (Math.abs(drift.cash) > tolerance) {
    warnings.push(
      `Cash drift $${drift.cash.toFixed(2)} (source ${source.cash.toFixed(2)} vs journal ${journal.cash.toFixed(2)})`,
    );
  }
  return { drift, balanced: warnings.length === 0, warnings };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(23, 59, 59, 999);
  return out;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Runs the reconciliation for a given date. Loads source data + the
 * day's POSTED/EXPORTED JE, computes both sides, returns the result.
 * Caller decides whether to persist the result to DailyReconciliationLog.
 */
export async function computeDailyReconciliation(opts: {
  date: Date;
  client: PrismaClient | Prisma.TransactionClient;
}): Promise<DailyReconciliationResult> {
  const { date, client } = opts;
  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);

  // Source-side queries
  const lineItems = await client.orderLineItem.findMany({
    where: {
      lineItemStatus: { not: "CANCELLED" },
      salesOrder: {
        orderDate: { gte: dayStart, lte: dayEnd },
        status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
      },
    },
    select: { netPrice: true, vatAmount: true, cost: true },
  });

  const payments = await client.payment.findMany({
    where: {
      paymentDate: { gte: dayStart, lte: dayEnd },
      status: "COMPLETED",
    },
    select: { paymentAmount: true },
  });

  const source: DailyReconciliationSource = {
    revenue: round2(lineItems.reduce((s, li) => s + Number(li.netPrice ?? 0), 0)),
    tax: round2(lineItems.reduce((s, li) => s + Number(li.vatAmount ?? 0), 0)),
    cost: round2(lineItems.reduce((s, li) => s + Number(li.cost ?? 0), 0)),
    cash: round2(payments.reduce((s, p) => s + Number(p.paymentAmount ?? 0), 0)),
  };

  // Load the day's JE (if any)
  const je = await client.journalEntry.findFirst({
    where: {
      journalDate: { gte: dayStart, lte: dayEnd },
      status: { in: ["POSTED", "EXPORTED"] },
    },
    include: {
      lines: { include: { glAccount: { select: { code: true } } } },
    },
  });

  const journal: DailyReconciliationJournal = { revenue: 0, tax: 0, cost: 0, cash: 0 };
  if (je) {
    for (const line of je.lines) {
      const code = line.glAccount?.code ?? "";
      const debit = Number(line.debit ?? 0);
      const credit = Number(line.credit ?? 0);
      if (code.startsWith("4-")) {
        // Sales revenue: normal credit balance
        journal.revenue += credit - debit;
      } else if (code === "2-2120") {
        // CT Sales Tax Payable
        journal.tax += credit - debit;
      } else if (code.startsWith("5-52")) {
        // COGS by department: normal debit balance
        journal.cost += debit - credit;
      } else if (code === "1-1006") {
        // Cash / combined receipts: normal debit balance
        journal.cash += debit - credit;
      }
    }
    journal.revenue = round2(journal.revenue);
    journal.tax = round2(journal.tax);
    journal.cost = round2(journal.cost);
    journal.cash = round2(journal.cash);
  }

  const { drift, balanced, warnings } = compareReconciliation(source, journal);

  if (!je) {
    warnings.unshift(
      `No POSTED/EXPORTED journal entry for ${dateStr(date)} — generate or post the JE first`,
    );
  }

  return {
    date: dateStr(date),
    hasJournalEntry: !!je,
    journalEntryId: je?.id ?? null,
    journalStatus: je?.status ?? null,
    source,
    journal,
    drift,
    balanced: balanced && !!je,
    warnings,
  };
}
