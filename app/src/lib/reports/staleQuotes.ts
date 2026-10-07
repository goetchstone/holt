// /app/src/lib/reports/staleQuotes.ts
//
// Stale quote cleanup report: old QUOTE-status orders needing follow-up or
// closure, filtered by minimum age + value. Extracted from the Pages API so the
// App Router page, the tRPC procedure, and any REST shim share one source of
// truth. CLAUDE.md rule 33: cancelled lines excluded. netPrice is the LINE
// TOTAL, not unit price.

import type { PrismaClient } from "@prisma/client";

export interface StaleQuoteRow {
  id: number;
  orderno: string;
  customerName: string;
  salesperson: string;
  quoteDate: string | null;
  ageDays: number;
  quoteValue: number;
  lineItemCount: number;
}

export interface StaleQuotesResult {
  rows: StaleQuoteRow[];
  totals: { total: number; totalValue: number; avgAge: number; oldestAge: number };
}

export interface StaleQuotesParams {
  minAge?: number;
  minValue?: number;
  salesperson?: string | null;
}

function ageInDays(date: Date | null, now: Date): number {
  if (!date) return 0;
  return Math.floor((now.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

function formatCustomerName(
  customer: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!customer) return "Unknown";
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return name || "Unknown";
}

export async function getStaleQuotes(
  prisma: PrismaClient,
  params: StaleQuotesParams = {},
): Promise<StaleQuotesResult> {
  const minAge = params.minAge ?? 30;
  const minValue = params.minValue ?? 0;
  const salesperson = params.salesperson ?? null;

  const quotes = await prisma.salesOrder.findMany({
    where: {
      status: "QUOTE",
      ...(salesperson ? { salesperson } : {}),
    },
    select: {
      id: true,
      orderno: true,
      quoteDate: true,
      orderDate: true,
      salesperson: true,
      customer: { select: { firstName: true, lastName: true } },
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: { netPrice: true, orderedQuantity: true },
      },
    },
    orderBy: [{ quoteDate: "asc" }, { orderDate: "asc" }],
  });

  const now = new Date();
  const rows: StaleQuoteRow[] = [];

  for (const q of quotes) {
    const date = q.quoteDate ?? q.orderDate;
    const ageDays = ageInDays(date, now);
    if (ageDays < minAge) continue;

    const quoteValue = Math.round(q.lineItems.reduce((s, li) => s + Number(li.netPrice), 0));
    if (quoteValue < minValue) continue;

    rows.push({
      id: q.id,
      orderno: q.orderno,
      customerName: formatCustomerName(q.customer),
      salesperson: q.salesperson || "Unassigned",
      quoteDate: date ? date.toISOString().slice(0, 10) : null,
      ageDays,
      quoteValue,
      lineItemCount: q.lineItems.length,
    });
  }

  rows.sort((a, b) => b.quoteValue - a.quoteValue);

  const totalValue = rows.reduce((s, r) => s + r.quoteValue, 0);
  const avgAge =
    rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.ageDays, 0) / rows.length) : 0;
  const oldestAge = rows.length > 0 ? Math.max(...rows.map((r) => r.ageDays)) : 0;

  return { rows, totals: { total: rows.length, totalValue, avgAge, oldestAge } };
}
