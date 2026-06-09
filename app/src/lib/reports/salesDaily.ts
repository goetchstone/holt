// /app/src/lib/reports/salesDaily.ts
//
// Daily sales totals from SalesOrder + OrderLineItem, grouped by date + store
// location, with optional date-range and department filters. Extracted from the
// Pages API so the tRPC procedure and any REST shim share one source of truth.
// CLAUDE.md rule 33: cancelled lines are excluded so they never inflate totals.
// Revenue statuses include RETURNED so negative return lines net correctly.

import type { PrismaClient, Prisma } from "@prisma/client";

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

  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
  };
  if (startDate && endDate) {
    orderWhere.orderDate = {
      gte: new Date(`${startDate}T00:00:00.000Z`),
      lte: new Date(`${endDate}T23:59:59.999Z`),
    };
  } else if (startDate) {
    orderWhere.orderDate = { gte: new Date(`${startDate}T00:00:00.000Z`) };
  } else if (endDate) {
    orderWhere.orderDate = { lte: new Date(`${endDate}T23:59:59.999Z`) };
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

    const dateKey = order.orderDate.toISOString().slice(0, 10);
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
