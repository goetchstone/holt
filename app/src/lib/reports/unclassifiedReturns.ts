// /app/src/lib/reports/unclassifiedReturns.ts
//
// "Unclassified Returns" — B3 exception report. Imported POS returns have no
// `Return` record at all (docs/domains/returns.md "the dual reality"), so the
// journal entry books them on the owner-directed default: assume restock
// (docs/domains/accounting.md "Returns"). That default is now a NAMED path
// (UNCLASSIFIED_DEFAULT_RESTOCK, see lib/journalEntry.ts) instead of a silent
// fallthrough — this report is the visibility half of that change: it lists
// every return-shaped line that booked on the default assumption so an
// accountant can review and, if one was actually damaged/unsalvageable,
// adjust it (classify a Return record, or fall back to the manual
// transfer-out workflow already documented for writeoffs).
//
// Reuses the SAME matching/classification helpers the journal-entry
// generator uses (matchReturnForLine / resolveReturnBookingPath from
// lib/journalEntry.ts) so this report can never drift from what was actually
// booked — one source of truth for "was this return classified."
//
// Invariants (docs/domains/reporting.md):
//  - Rule 33: `lineItemStatus: { not: "CANCELLED" }` on every line-item read.
//    (lineItemStatus is non-nullable in the current data — migration
//    20260505_backfill_lineitem_status_nulls backfilled every legacy NULL —
//    so a direct `not:` here does not hit the NULL-trap.)
//  - "A return = a line on a RETURNED SalesOrder" (lib/reports/returnsAnalysis.ts)
//    — scoped via `status: "RETURNED"`, a positive equality check, not a
//    negated filter on a nullable column.
//  - netPrice is the LINE TOTAL — summed/reported directly, never × quantity.

import type { PrismaClient } from "@prisma/client";
import {
  matchReturnForLine,
  resolveReturnBookingPath,
  type ReturnForJournal,
} from "@/lib/journalEntry";

export interface UnclassifiedReturnRow {
  lineItemId: number;
  orderId: number;
  orderno: string;
  date: string | null;
  store: string;
  customerName: string;
  description: string;
  amount: number; // positive magnitude of the return line
  reason: string;
}

export interface UnclassifiedReturnsResult {
  startDate: string;
  endDate: string;
  rows: UnclassifiedReturnRow[];
  totals: { count: number; totalAmount: number };
}

export interface UnclassifiedReturnsParams {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string; // YYYY-MM-DD inclusive
  store?: string | null;
}

// Raw shape as read from Prisma — exported so the pure builder below can be
// unit-tested without a database.
export interface RawReturnOrderRow {
  id: number;
  orderno: string;
  orderDate: Date | null;
  storeLocation: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  lineItems: {
    id: number;
    productId: number | null;
    productName: string | null;
    partNo: string | null;
    netPrice: unknown; // Prisma.Decimal
  }[];
  returns: ReturnForJournal[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function formatCustomerName(
  customer: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!customer) return "Unknown";
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return name || "Unknown";
}

/**
 * Why a given return-shaped line landed on the default-restock path, spelled
 * out for the accountant reviewing the exception list. Mirrors the match
 * tiers in `matchReturnForLine` so the explanation matches the actual
 * decision, not a guess at it.
 */
export function explainUnclassified(
  line: { id: number; productId: number | null },
  returns: ReadonlyArray<ReturnForJournal>,
): string {
  if (returns.length === 0) {
    return "No Return record — imported/historical return, restock assumed";
  }
  const matched = matchReturnForLine(line, returns);
  if (!matched) {
    return "Return record(s) exist on this order but none link to this line — ambiguous match, restock assumed";
  }
  return "Return record exists but hasn't been inspected/classified yet — restock assumed";
}

/**
 * Shapes raw SalesOrder+lineItems+returns rows into the exception-report
 * rows: for every return-shaped (negative netPrice) line, resolve the same
 * B3 booking path the JE generator uses and keep only the ones that took the
 * UNCLASSIFIED_DEFAULT_RESTOCK path. Pure — no I/O — so every branch here is
 * unit-tested without a database.
 */
export function buildUnclassifiedReturnsRows(
  orders: RawReturnOrderRow[],
  meta: { startDate: string; endDate: string },
): UnclassifiedReturnsResult {
  const rows: UnclassifiedReturnRow[] = [];

  for (const order of orders) {
    const customerName = formatCustomerName(order.customer);
    const store = order.storeLocation || "Unassigned";
    const date = order.orderDate ? order.orderDate.toISOString().slice(0, 10) : null;

    for (const li of order.lineItems) {
      const netPrice = Number(li.netPrice) || 0;
      if (netPrice >= 0) continue; // not a return-shaped line

      const path = resolveReturnBookingPath({ id: li.id, productId: li.productId }, order.returns);
      if (path !== "UNCLASSIFIED_DEFAULT_RESTOCK") continue;

      rows.push({
        lineItemId: li.id,
        orderId: order.id,
        orderno: order.orderno,
        date,
        store,
        customerName,
        description: li.productName || li.partNo || `line ${li.id}`,
        amount: round2(Math.abs(netPrice)),
        reason: explainUnclassified({ id: li.id, productId: li.productId }, order.returns),
      });
    }
  }

  rows.sort((a, b) => b.amount - a.amount);

  const totalAmount = round2(rows.reduce((s, r) => s + r.amount, 0));

  return {
    startDate: meta.startDate,
    endDate: meta.endDate,
    rows,
    totals: { count: rows.length, totalAmount },
  };
}

export async function getUnclassifiedReturns(
  prisma: PrismaClient,
  params: UnclassifiedReturnsParams,
): Promise<UnclassifiedReturnsResult> {
  const { startDate, endDate, store = null } = params;

  const rangeEnd = new Date(endDate);
  rangeEnd.setDate(rangeEnd.getDate() + 1); // endDate is inclusive

  const orders = await prisma.salesOrder.findMany({
    where: {
      status: "RETURNED",
      orderDate: { gte: new Date(startDate), lt: rangeEnd },
      ...(store ? { storeLocation: store } : {}),
    },
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      storeLocation: true,
      customer: { select: { firstName: true, lastName: true } },
      lineItems: {
        // Rule 33 (cancelled-line filter) AND scope to return-shaped lines
        // only — netPrice is non-nullable, so this is a plain numeric
        // comparison, not a negated filter on a nullable column.
        where: { lineItemStatus: { not: "CANCELLED" }, netPrice: { lt: 0 } },
        select: { id: true, productId: true, productName: true, partNo: true, netPrice: true },
      },
      returns: {
        select: {
          id: true,
          lineItemId: true,
          productId: true,
          status: true,
          inspectionCondition: true,
        },
      },
    },
    orderBy: { orderDate: "desc" },
  });

  return buildUnclassifiedReturnsRows(orders, { startDate, endDate });
}
