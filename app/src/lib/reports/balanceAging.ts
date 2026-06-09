// /app/src/lib/reports/balanceAging.ts
//
// Balance-due aging report: unpaid balances on open orders by age bucket and
// salesperson. Extracted from the Pages API so the App Router server component,
// the tRPC procedure, AND the integration test share ONE implementation (the
// test previously re-implemented this query inline and drifted; now it imports
// getBalanceAging directly).
//
// Invariants preserved verbatim from the handler:
//  - netPrice is the LINE TOTAL (not unit price); order total = sum(netPrice + vatAmount).
//  - CLAUDE.md rule 33: cancelled lines excluded.
//  - VOIDED/FAILED payments excluded; NULL-status payments INCLUDED (44K legacy
//    POS rows are real money) — CLAUDE.md rule 51.

import type { PrismaClient } from "@prisma/client";

export interface BalanceRow {
  id: number;
  orderno: string;
  customerId: number | null;
  customerName: string;
  salesperson: string;
  orderDate: string | null;
  orderTotal: number;
  totalPaid: number;
  balanceDue: number;
  ageDays: number;
  ageBucket: string;
}

export interface BalanceAgingResult {
  rows: BalanceRow[];
  totals: {
    total: number;
    totalBalance: number;
    current: number;
    overdue: number;
    serious: number;
  };
}

export interface BalanceAgingParams {
  salesperson?: string | null;
  minBalance?: number;
  ageBucket?: string | null;
}

function computeOrderTotal(lineItems: { netPrice: unknown; vatAmount: unknown }[]): number {
  return lineItems.reduce((s, li) => s + Number(li.netPrice) + Number(li.vatAmount ?? 0), 0);
}

function splitPayments(payments: { paymentAmount: unknown; isRefund: boolean }[]): {
  paid: number;
  refunds: number;
} {
  let paid = 0;
  let refunds = 0;
  for (const p of payments) {
    const amt = Number(p.paymentAmount);
    if (p.isRefund) refunds += amt;
    else paid += amt;
  }
  return { paid, refunds };
}

export function bucketForAge(ageDays: number): string {
  if (ageDays <= 30) return "0-30 days";
  if (ageDays <= 90) return "31-90 days";
  if (ageDays <= 180) return "91-180 days";
  return "180+ days";
}

function formatCustomerName(
  customer: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!customer) return "Unknown";
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return name || "Unknown";
}

export async function getBalanceAging(
  prisma: PrismaClient,
  params: BalanceAgingParams = {},
): Promise<BalanceAgingResult> {
  const { salesperson = null, minBalance = 0, ageBucket = null } = params;

  const orders = await prisma.salesOrder.findMany({
    where: {
      status: "ORDER",
      ...(salesperson ? { salesperson } : {}),
    },
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      salesperson: true,
      customer: { select: { id: true, firstName: true, lastName: true } },
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: { netPrice: true, orderedQuantity: true, vatAmount: true },
      },
      payments: {
        where: { OR: [{ status: null }, { status: { notIn: ["VOIDED", "FAILED"] } }] },
        select: { paymentAmount: true, isRefund: true },
      },
    },
    orderBy: { orderDate: "asc" },
  });

  const now = new Date();
  const rows: BalanceRow[] = [];

  for (const o of orders) {
    const orderTotal = computeOrderTotal(o.lineItems);
    const { paid: totalPaid, refunds } = splitPayments(o.payments);
    const balanceDue = orderTotal - totalPaid + refunds;
    if (balanceDue <= minBalance) continue;

    const ageDays = o.orderDate
      ? Math.floor((now.getTime() - new Date(o.orderDate).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const bucket = bucketForAge(ageDays);
    if (ageBucket && bucket !== ageBucket) continue;

    rows.push({
      id: o.id,
      orderno: o.orderno,
      customerId: o.customer?.id ?? null,
      customerName: formatCustomerName(o.customer),
      salesperson: o.salesperson || "Unassigned",
      orderDate: o.orderDate ? o.orderDate.toISOString().slice(0, 10) : null,
      orderTotal: Math.round(orderTotal),
      totalPaid: Math.round(totalPaid),
      balanceDue: Math.round(balanceDue),
      ageDays,
      ageBucket: bucket,
    });
  }

  rows.sort((a, b) => b.balanceDue - a.balanceDue);

  const sumBucket = (pred: (r: BalanceRow) => boolean) =>
    rows.filter(pred).reduce((s, r) => s + r.balanceDue, 0);

  return {
    rows,
    totals: {
      total: rows.length,
      totalBalance: rows.reduce((s, r) => s + r.balanceDue, 0),
      current: sumBucket((r) => r.ageBucket === "0-30 days"),
      overdue: sumBucket((r) => r.ageBucket === "31-90 days"),
      serious: sumBucket((r) => r.ageBucket === "91-180 days" || r.ageBucket === "180+ days"),
    },
  };
}
