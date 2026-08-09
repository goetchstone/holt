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
import {
  POS_PAYMENTS_SECTION,
  POS_TRANSACTIONS_SECTION,
  CASH_MAPPING_LABEL,
  SALES_TAX_MAPPING_LABEL,
  OVER_SHORT_MAPPING_LABEL,
  OVER_SHORT_ALERT_THRESHOLD,
} from "./glMapping";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { businessDayRange, getBusinessTimeZone } from "@/lib/reports/businessDay";

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
  /** Sum of credits − debits on the departments' sales GL accounts
   * (`AccountGroup.salesAccount`) in the day's POSTED/EXPORTED JE.
   * Positive = net revenue credited (normal sale day). */
  revenue: number;
  /** Same shape for tax accounts (every `TaxDistrict.glAccountId`, plus the
   * `POS_TRANSACTIONS`/"Sales Tax" fallback mapping). */
  tax: number;
  /** Sum of debits − credits on the departments' COGS GL accounts
   * (`AccountGroup.cogsAccount`). Positive = net expense recognized. */
  cost: number;
  /** Sum of debits − credits on the combined-receipts account
   * (`POS_PAYMENTS`/"Cash"). Positive = net cash in. */
  cash: number;
  /**
   * Sum of credits − debits on the Over/Short account
   * (`POS_TRANSACTIONS`/"Over/Short"). This is the plug the JE generator
   * posted to force the entry into balance, reported as its own figure so a
   * reconciling human reads "plug: $X" instead of chasing a phantom revenue
   * discrepancy.
   *
   * Signed to match `totalDebits - totalCredits` before the plug: positive
   * means the journal's debits exceeded its credits and the plug was a
   * credit. It is deliberately NOT folded into `revenue` -- an Over/Short
   * balance is not sales, whatever `GLAccount.accountType` a given
   * deployment happens to have given the account.
   */
  overShort: number;
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

  // The plug has no source-side counterpart -- there is no "real" Over/Short
  // out in the order data to drift against -- so it is reported on its own
  // terms: the journal balanced only because someone's money is unaccounted
  // for. Graded against OVER_SHORT_ALERT_THRESHOLD rather than `tolerance`,
  // because a two-cent rounding plug should be stated (it still comes back as
  // `journal.overShort`, and both admin tables show it) without turning the
  // whole day amber.
  if (Math.abs(journal.overShort) > OVER_SHORT_ALERT_THRESHOLD) {
    warnings.push(
      `Over/Short plug $${Math.abs(journal.overShort).toFixed(2)} — the journal balances only because of it. ` +
        `This is not revenue and nothing in the source data explains it; a payment or a line item is probably missing.`,
    );
  }

  return { drift, balanced: warnings.length === 0, warnings };
}

/**
 * Normalizes a date marker to UTC midnight of its own calendar day. Callers
 * already pass markers, but a caller that passed an instant would otherwise
 * silently miss the journal; this makes the marker convention explicit at the
 * one place it is matched.
 */
function markerUtcMidnight(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Which GL accounts play which role in this deployment's chart, resolved by
 * FK id rather than by account code.
 *
 * Nothing in here reads a code string. That is the point: this control used
 * to test `code.startsWith("4-")`, `code === "2-2120"`, `code.startsWith("5-52")`
 * and `code === "1-1006"` -- four facts about ONE business's numbering baked
 * into product source (CLAUDE.md rule 61, the same family as the
 * `shortName: "CT"` tax bug). A deployment with any other chart got a
 * reconciliation that reported $0.00 for every bucket, which is
 * indistinguishable from a clean day.
 */
export interface ReconciliationAccounts {
  revenue: Set<number>;
  tax: Set<number>;
  cost: Set<number>;
  cash: Set<number>;
  overShort: Set<number>;
  warnings: string[];
}

/**
 * Turns an unresolvable bucket into a sentence naming which mapping is
 * absent. A bucket nobody configured sums to $0.00, and $0.00 against $0.00
 * of source data drifts by nothing — indistinguishable from a clean day
 * unless it is said out loud.
 */
function describeMappingGaps(sets: Omit<ReconciliationAccounts, "warnings">): string[] {
  const warnings: string[] = [];
  const configureAt = "Configure account groups at /app/admin/setup/accounting.";

  if (sets.revenue.size === 0) {
    warnings.push(
      `No AccountGroup has a sales GL account configured — the journal revenue bucket will read $0.00. ${configureAt}`,
    );
  }
  if (sets.cost.size === 0) {
    warnings.push(
      `No AccountGroup has a COGS GL account configured — the journal cost bucket will read $0.00. ${configureAt}`,
    );
  }
  if (sets.tax.size === 0) {
    warnings.push(
      `No tax GL account is configured — no TaxDistrict has one and there is no ${POS_TRANSACTIONS_SECTION}/"${SALES_TAX_MAPPING_LABEL}" mapping. The journal tax bucket will read $0.00.`,
    );
  }
  if (sets.cash.size === 0) {
    warnings.push(
      `No ${POS_PAYMENTS_SECTION}/"${CASH_MAPPING_LABEL}" GL mapping — the journal cash bucket will read $0.00.`,
    );
  }
  // An absent Over/Short mapping is a legitimate (stricter) configuration: no
  // mapping means the generator cannot plug at all, and it warns instead. So
  // that one is deliberately not reported here.

  // The plug account doubling as a revenue or COGS account is precisely how a
  // plug gets laundered into the P&L. Classification gives Over/Short
  // priority, but say so out loud rather than quietly compensating.
  const collides = [...sets.overShort].some((id) => sets.revenue.has(id) || sets.cost.has(id));
  if (collides) {
    warnings.push(
      "The Over/Short GL is also configured as a department's sales or COGS account — plugs would be reported as revenue or cost. Give Over/Short its own account.",
    );
  }

  return warnings;
}

/**
 * Resolves the account sets above from configuration.
 *
 * Why two different mechanisms, and why each is the honest signal:
 *
 * REVENUE and COGS come from `AccountGroup.salesAccount` / `cogsAccount`.
 * They are per-department -- one sales account and one COGS account per
 * `AccountGroup` -- so a single `SystemGLMapping` row cannot name them. The
 * tempting alternative is `GLAccount.accountType === "REVENUE"`, and it is the
 * WRONG signal: `accountType` is a label nothing enforces, while `AccountGroup`
 * is the wiring `buildJournalLines` actually follows when it decides which
 * account to credit (`li.accountGroup.salesGlId`). Reading the same rows the
 * generator reads is what makes the two sides comparable at all; reading
 * `accountType` instead would let the control and the generator disagree about
 * what revenue even is. It also walks straight into this change's own bug --
 * the demo seed typed Over/Short `REVENUE`, so an `accountType` test would
 * have swept the plug right back into the revenue bucket.
 *
 * TAX is per-district, so it is the union of every `TaxDistrict.glAccountId`
 * plus the `POS_TRANSACTIONS`/"Sales Tax" fallback -- exactly the two places
 * `generateSalesJournal` looks when it resolves an order's tax GL. This also
 * retires the old "we approximate by GL code prefix 2-2120" comment: a second
 * state's district is now counted instead of silently dropped.
 *
 * CASH and OVER/SHORT are genuine singletons and come from `SystemGLMapping`.
 */
export async function resolveReconciliationAccounts(
  client: PrismaClient | Prisma.TransactionClient,
): Promise<ReconciliationAccounts> {
  const warnings: string[] = [];

  const [groups, districts, mappings] = await Promise.all([
    client.accountGroup.findMany({
      select: { salesAccountId: true, cogsAccountId: true },
    }),
    client.taxDistrict.findMany({ select: { glAccountId: true } }),
    client.systemGLMapping.findMany({
      where: {
        OR: [
          { section: POS_PAYMENTS_SECTION, label: CASH_MAPPING_LABEL },
          {
            section: POS_TRANSACTIONS_SECTION,
            label: { in: [SALES_TAX_MAPPING_LABEL, OVER_SHORT_MAPPING_LABEL] },
          },
        ],
      },
      select: { section: true, label: true, glAccountId: true },
    }),
  ]);

  const mappingId = (section: string, label: string): number | null =>
    mappings.find((m) => m.section === section && m.label === label)?.glAccountId ?? null;

  const revenue = new Set<number>();
  const cost = new Set<number>();
  for (const g of groups) {
    if (g.salesAccountId != null) revenue.add(g.salesAccountId);
    if (g.cogsAccountId != null) cost.add(g.cogsAccountId);
  }

  const tax = new Set<number>();
  for (const d of districts) {
    if (d.glAccountId != null) tax.add(d.glAccountId);
  }
  const taxFallbackId = mappingId(POS_TRANSACTIONS_SECTION, SALES_TAX_MAPPING_LABEL);
  if (taxFallbackId != null) tax.add(taxFallbackId);

  const cash = new Set<number>();
  const cashId = mappingId(POS_PAYMENTS_SECTION, CASH_MAPPING_LABEL);
  if (cashId != null) cash.add(cashId);

  const overShort = new Set<number>();
  const overShortId = mappingId(POS_TRANSACTIONS_SECTION, OVER_SHORT_MAPPING_LABEL);
  if (overShortId != null) overShort.add(overShortId);

  warnings.push(...describeMappingGaps({ revenue, tax, cost, cash, overShort }));

  return { revenue, tax, cost, cash, overShort, warnings };
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
  // `date` is a DATE MARKER (UTC midnight of a calendar day) -- that is what
  // parseRange, enumerateDays and JournalEntry.journalDate all carry.
  // businessDayRange turns it into the half-open instant window the deployment
  // actually traded over.
  //
  // This used to be startOfDay/endOfDay, i.e. setUTCHours(0..) / (23:59:59.999)
  // on the marker, which reconciled the UTC calendar day no matter what
  // AppSettings.timezone said. For America/New_York that shifted the window 4-5
  // hours off the trading day; for any zone EAST of UTC the caller's
  // businessDayStart anchor landed on the previous UTC date and the whole
  // reconciliation ran on the wrong day.
  const timeZone = await getBusinessTimeZone();
  const { gte: dayStart, lt: dayEndExclusive } = businessDayRange(
    date.toISOString().slice(0, 10),
    timeZone,
  );

  // Source-side queries
  const lineItems = await client.orderLineItem.findMany({
    where: {
      lineItemStatus: { not: "CANCELLED" },
      salesOrder: {
        orderDate: { gte: dayStart, lt: dayEndExclusive },
        status: { in: [...SALES_REVENUE_STATUSES] },
      },
    },
    select: { netPrice: true, vatAmount: true, cost: true },
  });

  const payments = await client.payment.findMany({
    where: {
      paymentDate: { gte: dayStart, lt: dayEndExclusive },
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

  // Which account is which, per this deployment's configuration.
  const accounts = await resolveReconciliationAccounts(client);

  // Load the day's JE (if any).
  //
  // Matched on the DATE MARKER, deliberately NOT on the business-day instant
  // window above. `JournalEntry.journalDate` stores UTC midnight of the
  // calendar day (see generateSalesJournal), so for any timezone west of UTC
  // the marker sits BEFORE dayStart -- filtering it by the trading window would
  // find no journal at all and report every day as unreconciled. Sources are
  // instants and get the window; the journal is a date and gets the marker.
  const je = await client.journalEntry.findFirst({
    where: {
      journalDate: markerUtcMidnight(date),
      status: { in: ["POSTED", "EXPORTED"] },
    },
    include: { lines: true },
  });

  const journal: DailyReconciliationJournal = {
    revenue: 0,
    tax: 0,
    cost: 0,
    cash: 0,
    overShort: 0,
  };
  if (je) {
    for (const line of je.lines) {
      const id = line.glAccountId;
      const debit = Number(line.debit ?? 0);
      const credit = Number(line.credit ?? 0);
      // Over/Short is tested FIRST so that a chart which (wrongly) also lists
      // the plug account as a department's sales account still reports the
      // plug as a plug rather than as revenue. Lines on accounts in none of
      // these sets -- inventory, gift-card liability, deposits -- are
      // intentionally not summed into any bucket, exactly as before.
      if (accounts.overShort.has(id)) {
        journal.overShort += credit - debit;
      } else if (accounts.revenue.has(id)) {
        journal.revenue += credit - debit;
      } else if (accounts.tax.has(id)) {
        journal.tax += credit - debit;
      } else if (accounts.cost.has(id)) {
        journal.cost += debit - credit;
      } else if (accounts.cash.has(id)) {
        journal.cash += debit - credit;
      }
    }
    journal.revenue = round2(journal.revenue);
    journal.tax = round2(journal.tax);
    journal.cost = round2(journal.cost);
    journal.cash = round2(journal.cash);
    journal.overShort = round2(journal.overShort);
  }

  const { drift, balanced, warnings } = compareReconciliation(source, journal);
  // Configuration problems go first: "revenue drift $8,000" is a misleading
  // thing to read when the real story is that no sales account is mapped.
  warnings.unshift(...accounts.warnings);

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
    // A chart we could not resolve is not a clean day, however small the
    // drift looks: unresolved buckets read $0.00, and $0.00 vs $0.00 drifts
    // by nothing. That is the silent-success shape this control exists to
    // prevent, so an unresolved mapping fails the day outright.
    balanced: balanced && !!je && accounts.warnings.length === 0,
    warnings,
  };
}
