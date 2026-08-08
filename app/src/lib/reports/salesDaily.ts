// /app/src/lib/reports/salesDaily.ts
//
// Daily sales totals from SalesOrder + OrderLineItem, grouped by date + store
// location, with optional date-range and department filters. Extracted from the
// Pages API so the tRPC procedure and any REST shim share one source of truth.
// CLAUDE.md rule 33: cancelled lines are excluded so they never inflate totals.
// Revenue statuses include RETURNED so negative return lines net correctly.

import type { PrismaClient, Prisma } from "@prisma/client";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { businessDayKey, businessDayRange, getBusinessTimeZone } from "@/lib/reports/businessDay";

export interface SalesDailyParams {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  departments?: string[]; // department names
}

export interface SalesDailyRow {
  orderDate: string;
  storeLocation: string;
  totalSales: number;
  transactionCount: number;
}

export async function getSalesDaily(
  prisma: PrismaClient,
  params: SalesDailyParams = {},
): Promise<SalesDailyRow[]> {
  const { startDate, endDate, departments = [] } = params;

  // The deployment's business timezone, not UTC and not the viewer's. See
  // lib/reports/businessDay.ts for why this exists at all; the short version is
  // that a sale at 8pm Eastern is stored as 00:00Z the next day, so reading the
  // date off the instant reported it on the wrong day.
  const timeZone = await getBusinessTimeZone();

  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: [...SALES_REVENUE_STATUSES] },
  };
  // Half-open bounds derived from the business day, replacing the literal
  // `T00:00:00.000Z` / `T23:59:59.999Z` UTC edges. The end bound is the START of
  // the day after endDate, so the last second of the range cannot be missed and
  // a DST day (23 or 25 hours) is still covered exactly.
  if (startDate || endDate) {
    orderWhere.orderDate = {
      ...(startDate ? { gte: businessDayRange(startDate, timeZone).gte } : {}),
      ...(endDate ? { lt: businessDayRange(endDate, timeZone).lt } : {}),
    };
  }

  const lineItemWhere: Prisma.OrderLineItemWhereInput = {
    lineItemStatus: { not: "CANCELLED" },
  };
  if (departments.length > 0) {
    lineItemWhere.product = { department: { name: { in: departments } } };
  }

  const orders = await prisma.salesOrder.findMany({
    where: orderWhere,
    select: {
      id: true,
      orderDate: true,
      storeLocation: true,
      lineItems: { where: lineItemWhere, select: { netPrice: true } },
    },
  });

  const grouped: Record<string, { totalSales: number; transactionCount: number }> = {};

  for (const order of orders) {
    if (order.lineItems.length === 0) continue;
    if (!order.orderDate) continue;

    // Was `order.orderDate.toISOString().slice(0, 10)` — the UTC calendar date,
    // which put an 8pm Eastern sale on the following day.
    const dateKey = businessDayKey(order.orderDate, timeZone);
    const store = order.storeLocation || "Unknown";
    const key = `${dateKey}|${store}`;

    let lineTotal = 0;
    for (const li of order.lineItems) lineTotal += Number(li.netPrice || 0);

    if (grouped[key]) {
      grouped[key].totalSales += lineTotal;
      grouped[key].transactionCount += order.lineItems.length;
    } else {
      grouped[key] = { totalSales: lineTotal, transactionCount: order.lineItems.length };
    }
  }

  return Object.entries(grouped)
    .map(([key, data]) => {
      const [orderDate, storeLocation] = key.split("|");
      return {
        orderDate,
        storeLocation,
        totalSales: Math.round(data.totalSales * 100) / 100,
        transactionCount: data.transactionCount,
      };
    })
    .sort(
      (a, b) =>
        b.orderDate.localeCompare(a.orderDate) || a.storeLocation.localeCompare(b.storeLocation),
    );
}
