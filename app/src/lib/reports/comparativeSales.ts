// /app/src/lib/reports/comparativeSales.ts
//
// Comparative sales report: two date ranges with variance, grouped by store and
// optionally filtered by department. Includes store-wide door-counter traffic so
// the page can show conversion %. Extracted from the Pages API so the App Router
// page + tRPC procedure share one source of truth. CLAUDE.md rule 33: cancelled
// lines excluded. Revenue statuses include RETURNED so returns net out.

import type { PrismaClient } from "@prisma/client";
import { visitorsByStoreLocation } from "@/lib/storeTraffic";

interface StorePeriodData {
  netSales: number;
  orderCount: number;
  itemCount: number;
  // Store-wide door-counter visitors for the period (co-located counters summed
  // into one physical store). NOT department-specific — conversion math is only
  // meaningful with no department filter, which the page enforces.
  visitors: number;
}

export interface ComparativeRow {
  store: string;
  period1: StorePeriodData;
  period2: StorePeriodData;
  variance: number;
  variancePct: number | null;
}

export interface ComparativeResponse {
  period1Label: string;
  period2Label: string;
  rows: ComparativeRow[];
  totals: {
    period1: StorePeriodData;
    period2: StorePeriodData;
    variance: number;
    variancePct: number | null;
  };
  departments: string[];
  departmentFiltered: boolean;
}

export interface ComparativeSalesParams {
  p1Start: string;
  p1End: string;
  p2Start: string;
  p2End: string;
  departmentId?: number | null;
}

async function sumByStore(
  prisma: PrismaClient,
  from: Date,
  to: Date,
  departmentId?: number,
): Promise<Record<string, StorePeriodData>> {
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: from, lt: to },
      status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
    },
    select: {
      id: true,
      storeLocation: true,
      lineItems: {
        where: {
          lineItemStatus: { not: "CANCELLED" },
          ...(departmentId ? { product: { departmentId } } : {}),
        },
        select: { netPrice: true },
      },
    },
  });

  const result: Record<string, StorePeriodData> = {};
  const ordersByStore = new Map<string, Set<number>>();

  for (const order of orders) {
    if (order.lineItems.length === 0) continue;
    const store = order.storeLocation || "Unknown";
    if (!result[store]) result[store] = { netSales: 0, orderCount: 0, itemCount: 0, visitors: 0 };
    if (!ordersByStore.has(store)) ordersByStore.set(store, new Set());

    for (const li of order.lineItems) {
      result[store].netSales += Number(li.netPrice || 0);
      result[store].itemCount++;
    }
    ordersByStore.get(store)!.add(order.id);
  }

  for (const [store, orderSet] of ordersByStore) {
    result[store].orderCount = orderSet.size;
  }

  return result;
}

export async function getComparativeSales(
  prisma: PrismaClient,
  params: ComparativeSalesParams,
): Promise<ComparativeResponse> {
  const { p1Start, p1End, p2Start, p2End } = params;
  const departmentId = params.departmentId ?? undefined;

  const from1 = new Date(p1Start);
  const to1 = new Date(p1End);
  to1.setDate(to1.getDate() + 1);
  const from2 = new Date(p2Start);
  const to2 = new Date(p2End);
  to2.setDate(to2.getDate() + 1);

  const [data1, data2, visitors1, visitors2, departments] = await Promise.all([
    sumByStore(prisma, from1, to1, departmentId),
    sumByStore(prisma, from2, to2, departmentId),
    visitorsByStoreLocation(from1, to1),
    visitorsByStoreLocation(from2, to2),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const allStores = new Set([
    ...Object.keys(data1),
    ...Object.keys(data2),
    ...Object.keys(visitors1),
    ...Object.keys(visitors2),
  ]);
  allStores.delete("Unknown");

  const empty: StorePeriodData = { netSales: 0, orderCount: 0, itemCount: 0, visitors: 0 };
  const rows: ComparativeRow[] = Array.from(allStores)
    .sort((a, b) => a.localeCompare(b))
    .map((store) => {
      const p1 = { ...empty, ...data1[store], visitors: visitors1[store] ?? 0 };
      const p2 = { ...empty, ...data2[store], visitors: visitors2[store] ?? 0 };
      const variance = p1.netSales - p2.netSales;
      const variancePct = p2.netSales > 0 ? (variance / p2.netSales) * 100 : null;
      return {
        store,
        period1: { ...p1, netSales: Math.round(p1.netSales * 100) / 100 },
        period2: { ...p2, netSales: Math.round(p2.netSales * 100) / 100 },
        variance: Math.round(variance * 100) / 100,
        variancePct: variancePct !== null ? Math.round(variancePct * 10) / 10 : null,
      };
    });

  const t1: StorePeriodData = { netSales: 0, orderCount: 0, itemCount: 0, visitors: 0 };
  const t2: StorePeriodData = { netSales: 0, orderCount: 0, itemCount: 0, visitors: 0 };
  for (const r of rows) {
    t1.netSales += r.period1.netSales;
    t1.orderCount += r.period1.orderCount;
    t1.itemCount += r.period1.itemCount;
    t1.visitors += r.period1.visitors;
    t2.netSales += r.period2.netSales;
    t2.orderCount += r.period2.orderCount;
    t2.itemCount += r.period2.itemCount;
    t2.visitors += r.period2.visitors;
  }
  const totalVariance = t1.netSales - t2.netSales;
  const totalPct = t2.netSales > 0 ? (totalVariance / t2.netSales) * 100 : null;

  return {
    period1Label: `${p1Start} to ${p1End}`,
    period2Label: `${p2Start} to ${p2End}`,
    rows,
    totals: {
      period1: { ...t1, netSales: Math.round(t1.netSales * 100) / 100 },
      period2: { ...t2, netSales: Math.round(t2.netSales * 100) / 100 },
      variance: Math.round(totalVariance * 100) / 100,
      variancePct: totalPct !== null ? Math.round(totalPct * 10) / 10 : null,
    },
    departments: departments.map((d) => `${d.id}:${d.name}`),
    departmentFiltered: departmentId !== undefined,
  };
}
