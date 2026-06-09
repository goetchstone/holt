// /app/src/lib/reports/salesPerformance.ts
//
// Sales performance report: KPIs (range total, MTD/YTD vs prior year), daily
// trend, by-store, and by-department breakdowns. Extracted from the Pages API so
// the App Router page + tRPC procedure share one source of truth. CLAUDE.md rule
// 33: cancelled lines excluded. Revenue statuses include RETURNED so returns net
// out. netPrice is the LINE TOTAL, not unit price.

import type { Prisma, PrismaClient } from "@prisma/client";
import { SalesOrderStatus } from "@prisma/client";
import { format, subDays } from "date-fns";
import { getDateRanges } from "@/lib/reports/dateRanges";

export interface SalesPerformanceResponse {
  dateRange: { start: string; end: string };
  kpis: {
    totalSales: number;
    orderCount: number;
    avgOrderValue: number;
    mtdSales: number;
    mtdVsPrior: number;
    ytdSales: number;
    ytdVsPrior: number;
  };
  dailyTrend: Array<{ date: string; totalSales: number; orderCount: number }>;
  byStore: Array<{ store: string; totalSales: number; orderCount: number; avgOrder: number }>;
  byDepartment: Array<{ department: string; totalSales: number; itemCount: number }>;
}

export interface SalesPerformanceParams {
  startDate?: string;
  endDate?: string;
}

const QUALIFYING_STATUSES: SalesOrderStatus[] = [
  SalesOrderStatus.ORDER,
  SalesOrderStatus.FULFILLED,
  SalesOrderStatus.RETURNED,
];

function pct(current: number, prior: number): number {
  if (prior === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - prior) / prior) * 100 * 10) / 10;
}

function sumOrders(rows: Array<{ lineItems: Array<{ netPrice: unknown }> }>): number {
  return rows.reduce(
    (sum, o) => sum + o.lineItems.reduce((s, li) => s + Number(li.netPrice || 0), 0),
    0,
  );
}

export async function getSalesPerformance(
  prisma: PrismaClient,
  params: SalesPerformanceParams = {},
): Promise<SalesPerformanceResponse> {
  const rangeStart = params.startDate
    ? new Date(`${params.startDate}T00:00:00.000Z`)
    : (() => {
        const d = subDays(new Date(), 30);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      })();
  const rangeEnd = params.endDate ? new Date(`${params.endDate}T23:59:59.999Z`) : new Date();

  const startLabel = format(rangeStart, "yyyy-MM-dd");
  const endLabel = format(rangeEnd, "yyyy-MM-dd");

  const ranges = getDateRanges();

  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: QUALIFYING_STATUSES },
    orderDate: { gte: rangeStart, lte: rangeEnd },
  };

  const orders = await prisma.salesOrder.findMany({
    where: orderWhere,
    select: {
      id: true,
      orderDate: true,
      storeLocation: true,
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: {
          netPrice: true,
          product: { select: { department: { select: { name: true } } } },
        },
      },
    },
  });

  let totalSales = 0;
  const dailyMap = new Map<string, { totalSales: number; orderCount: number }>();
  const storeMap = new Map<string, { totalSales: number; orderCount: number }>();
  const deptMap = new Map<string, { totalSales: number; itemCount: number }>();

  for (const order of orders) {
    if (!order.orderDate) continue;
    const orderTotal = order.lineItems.reduce((sum, li) => sum + Number(li.netPrice || 0), 0);
    totalSales += orderTotal;

    const dayKey = format(new Date(order.orderDate), "yyyy-MM-dd");
    const dayEntry = dailyMap.get(dayKey) ?? { totalSales: 0, orderCount: 0 };
    dayEntry.totalSales += orderTotal;
    dayEntry.orderCount += 1;
    dailyMap.set(dayKey, dayEntry);

    const store = order.storeLocation || "Unknown";
    const storeEntry = storeMap.get(store) ?? { totalSales: 0, orderCount: 0 };
    storeEntry.totalSales += orderTotal;
    storeEntry.orderCount += 1;
    storeMap.set(store, storeEntry);

    for (const li of order.lineItems) {
      const lineNet = Number(li.netPrice || 0);
      if (lineNet <= 0) continue;
      const dept = li.product?.department?.name || "Uncategorized";
      const deptEntry = deptMap.get(dept) ?? { totalSales: 0, itemCount: 0 };
      deptEntry.totalSales += lineNet;
      deptEntry.itemCount += 1;
      deptMap.set(dept, deptEntry);
    }
  }

  const orderCount = orders.length;
  const avgOrderValue = orderCount > 0 ? totalSales / orderCount : 0;

  const lineSelect = {
    lineItems: {
      select: { netPrice: true },
      where: { lineItemStatus: { not: "CANCELLED" as const } },
    },
  };
  const [mtdOrders, prevMtdOrders, ytdOrders, prevYtdOrders] = await Promise.all([
    prisma.salesOrder.findMany({
      where: {
        status: { in: QUALIFYING_STATUSES },
        orderDate: { gte: ranges.mtd.start, lt: ranges.mtd.end },
      },
      select: lineSelect,
    }),
    prisma.salesOrder.findMany({
      where: {
        status: { in: QUALIFYING_STATUSES },
        orderDate: { gte: ranges.prevMtd.start, lt: ranges.prevMtd.end },
      },
      select: lineSelect,
    }),
    prisma.salesOrder.findMany({
      where: {
        status: { in: QUALIFYING_STATUSES },
        orderDate: { gte: ranges.ytd.start, lt: ranges.ytd.end },
      },
      select: lineSelect,
    }),
    prisma.salesOrder.findMany({
      where: {
        status: { in: QUALIFYING_STATUSES },
        orderDate: { gte: ranges.prevYtd.start, lt: ranges.prevYtd.end },
      },
      select: lineSelect,
    }),
  ]);

  const mtdSales = sumOrders(mtdOrders);
  const prevMtdSales = sumOrders(prevMtdOrders);
  const ytdSales = sumOrders(ytdOrders);
  const prevYtdSales = sumOrders(prevYtdOrders);

  const dailyTrend = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      totalSales: Math.round(v.totalSales * 100) / 100,
      orderCount: v.orderCount,
    }));

  const byStore = Array.from(storeMap.entries())
    .map(([store, v]) => ({
      store,
      totalSales: Math.round(v.totalSales * 100) / 100,
      orderCount: v.orderCount,
      avgOrder: v.orderCount > 0 ? Math.round((v.totalSales / v.orderCount) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.totalSales - a.totalSales);

  const byDepartment = Array.from(deptMap.entries())
    .map(([department, v]) => ({
      department,
      totalSales: Math.round(v.totalSales * 100) / 100,
      itemCount: v.itemCount,
    }))
    .sort((a, b) => b.totalSales - a.totalSales);

  return {
    dateRange: { start: startLabel, end: endLabel },
    kpis: {
      totalSales: Math.round(totalSales * 100) / 100,
      orderCount,
      avgOrderValue: Math.round(avgOrderValue * 100) / 100,
      mtdSales: Math.round(mtdSales * 100) / 100,
      mtdVsPrior: pct(mtdSales, prevMtdSales),
      ytdSales: Math.round(ytdSales * 100) / 100,
      ytdVsPrior: pct(ytdSales, prevYtdSales),
    },
    dailyTrend,
    byStore,
    byDepartment,
  };
}
