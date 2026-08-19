// /app/src/lib/reports/unmappedPayments.ts
//
// Money that will not reach the general ledger, and why.
//
// generateSalesJournal maps a payment to a GL account by looking up
// `Payment.paymentType`, lowercased, against the `SystemGLMapping` rows in the
// POS_PAYMENTS section (lib/journalEntry.ts). On a miss it pushes a warning and
// `continue`s — the payment is simply absent from the journal. The warning is
// returned to whoever generated that one day's entry and is visible nowhere
// else, so a deployment whose tender vocabulary drifted from its GL mapping
// loses money from the books quietly, one day at a time.
//
// Measured on a restored dataset when this was written: of 47,880 payments,
// ~43,100 had a paymentType with no mapping row. The dominant value, "Card
// Connect" (34,027 payments), matched nothing, while four configured labels
// (AMEX, Visa, MC, Discover) matched no payment at all. Nothing failed.
//
// This report is the standing version of that warning: every distinct unmapped
// paymentType, how many payments carry it, how much money that is, and when it
// was last seen — so the fix is "add these five mapping rows" rather than an
// investigation. Deliberately shaped like lib/reports/unclassifiedReturns.ts,
// which exists for the same reason on the returns side.
//
// It reports; it does not guess. Inferring a GL account from a tender string is
// exactly the kind of helpfulness that puts money in the wrong account.

import type { PrismaClient } from "@prisma/client";
import { POS_PAYMENTS_SECTION } from "@/lib/glMapping";

export interface UnmappedPaymentsParams {
  /** YYYY-MM-DD, inclusive. Omit both for all time — the default, because the
   *  question this answers is "how much is missing", not "how much this week". */
  startDate?: string;
  endDate?: string;
}

export interface UnmappedPaymentTypeRow {
  /** The `Payment.paymentType` string, verbatim as stored. */
  paymentType: string;
  count: number;
  /** Sum of paymentAmount. Signed: refunds are negative, so a refund-only
   *  tender shows a negative total rather than a misleading absolute. */
  totalAmount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface UnmappedPaymentsResult {
  rows: UnmappedPaymentTypeRow[];
  totals: {
    /** Distinct unmapped paymentType values. */
    distinctTypes: number;
    payments: number;
    amount: number;
  };
  /** Mapping labels configured but matching no payment. Not an error — a
   *  deployment may keep a label for a tender it no longer takes — but a label
   *  that never matches next to a payment type that never maps is usually one
   *  rename away from being the same thing. */
  unusedMappingLabels: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function getUnmappedPayments(
  prisma: PrismaClient,
  params: UnmappedPaymentsParams = {},
): Promise<UnmappedPaymentsResult> {
  const { startDate, endDate } = params;

  const where: {
    paymentDate?: { gte?: Date; lt?: Date };
  } = {};
  if (startDate || endDate) {
    where.paymentDate = {};
    if (startDate) where.paymentDate.gte = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) {
      // endDate is inclusive; half-open upper bound on the next day.
      const next = new Date(`${endDate}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      where.paymentDate.lt = next;
    }
  }

  const [mappings, grouped] = await Promise.all([
    prisma.systemGLMapping.findMany({
      where: { section: POS_PAYMENTS_SECTION },
      select: { label: true, glAccountId: true },
    }),
    prisma.payment.groupBy({
      by: ["paymentType"],
      where,
      _count: { _all: true },
      _sum: { paymentAmount: true },
      _min: { paymentDate: true },
      _max: { paymentDate: true },
    }),
  ]);

  // journalEntry.ts only builds a lookup entry when the mapping actually
  // resolves a GL account, so a label with a null glAccount is not a mapping
  // for this purpose. Matching is lowercased there; it is lowercased here.
  const mapped = new Set(
    mappings.filter((m) => m.glAccountId !== null).map((m) => m.label.toLowerCase()),
  );

  const seenTypes = new Set<string>();
  const rows: UnmappedPaymentTypeRow[] = [];

  for (const g of grouped) {
    const raw = g.paymentType ?? "";
    const key = raw.toLowerCase().trim();
    seenTypes.add(key);
    if (mapped.has(key)) continue;

    rows.push({
      paymentType: raw,
      count: g._count._all,
      totalAmount: round2(Number(g._sum.paymentAmount ?? 0)),
      firstSeen: (g._min.paymentDate ?? new Date(0)).toISOString().slice(0, 10),
      lastSeen: (g._max.paymentDate ?? new Date(0)).toISOString().slice(0, 10),
    });
  }

  // Biggest money first: the point is which mapping row to add next.
  rows.sort((a, b) => Math.abs(b.totalAmount) - Math.abs(a.totalAmount));

  const unusedMappingLabels = mappings
    .filter((m) => m.glAccountId !== null && !seenTypes.has(m.label.toLowerCase()))
    .map((m) => m.label)
    .sort((a, b) => a.localeCompare(b));

  return {
    rows,
    totals: {
      distinctTypes: rows.length,
      payments: rows.reduce((s, r) => s + r.count, 0),
      amount: round2(rows.reduce((s, r) => s + r.totalAmount, 0)),
    },
    unusedMappingLabels,
  };
}
