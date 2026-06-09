// /app/src/lib/reports/monthlyPerformance.ts
//
// Monthly performance report: sales, goals, bonus, quotes, and order metrics by
// month for one salesperson. Extracted from the Pages API so the App Router page
// + tRPC procedure share one source of truth. The caller-vs-requested salesperson
// authorization stays in the tRPC procedure (it needs the session); this lib
// takes an already-resolved salesperson name. CLAUDE.md rule 33 + RETURNED
// included (returns carry negative line items that reduce the total).

import type { PrismaClient } from "@prisma/client";
import { buildLineItemWhere } from "@/lib/salesBySalesperson";
import {
  MONTH_LABELS,
  DEFAULT_BONUS_RATE,
  evenMonthlyWeights,
  resolveMonthlyWeights,
} from "@/lib/goalsConfig";

export interface MonthRow {
  month: number;
  label: string;
  sales: number;
  goal: number;
  variance: number;
  variancePct: number | null;
  bonus: number;
  orderCount: number;
  avgOrderValue: number;
  quoteCount: number;
  convertedCount: number;
  conversionRate: number | null;
}

export interface MonthlyPerformanceResponse {
  salesperson: string;
  year: number;
  yearlyGoal: number;
  bonusRate: number;
  months: MonthRow[];
  totals: {
    sales: number;
    goal: number;
    variance: number;
    variancePct: number | null;
    bonus: number;
    orderCount: number;
    quoteCount: number;
    conversionRate: number | null;
  };
}

export interface MonthlyPerformanceParams {
  salesperson: string;
  year?: number;
}

const REVENUE_STATUSES = ["ORDER", "FULFILLED", "RETURNED"];

export async function getMonthlyPerformance(
  prisma: PrismaClient,
  params: MonthlyPerformanceParams,
): Promise<MonthlyPerformanceResponse> {
  const salesperson = params.salesperson;
  const year = params.year ?? new Date().getUTCFullYear();
  const startDate = new Date(Date.UTC(year, 0, 1));
  const endDate = new Date(Date.UTC(year + 1, 0, 1));

  const staffRecord = await prisma.staffMember.findFirst({
    where: { displayName: { equals: salesperson, mode: "insensitive" } },
    select: { id: true },
  });
  const staffId = staffRecord?.id ?? null;

  let yearlyGoal = 0;
  let bonusRate = DEFAULT_BONUS_RATE;
  let monthlyWeights = evenMonthlyWeights();

  if (staffId) {
    const goalRecord = await prisma.salesGoal.findUnique({
      where: { staffMemberId_fiscalYear: { staffMemberId: staffId, fiscalYear: year } },
    });
    if (goalRecord) {
      yearlyGoal = Number(goalRecord.yearlyGoal);
      bonusRate = Number(goalRecord.bonusRate);
      monthlyWeights = resolveMonthlyWeights(goalRecord.monthlyWeights);
    }
  }

  const allOrders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: startDate, lt: endDate },
      OR: [
        { salesperson: { equals: salesperson, mode: "insensitive" } },
        ...(staffId !== null ? [{ salesPersonId: staffId }] : []),
        ...(staffId !== null ? [{ splitWithId: staffId }] : []),
      ],
    },
    select: {
      id: true,
      orderDate: true,
      status: true,
      splitWithId: true,
      lineItems: {
        // Excludes cancelled lines (rule 33) and the delivery + freight
        // pass-throughs. Labor stays included.
        where: buildLineItemWhere([], false),
        select: { netPrice: true },
      },
    },
  });

  const months: MonthRow[] = [];

  for (let m = 0; m < 12; m++) {
    const monthStartTs = new Date(Date.UTC(year, m, 1)).getTime();
    const monthEndTs = new Date(Date.UTC(year, m + 1, 1)).getTime();

    const monthOrders = allOrders.filter((o) => {
      if (!o.orderDate) return false;
      const ts = new Date(o.orderDate).getTime();
      return ts >= monthStartTs && ts < monthEndTs;
    });

    const salesOrders = monthOrders.filter((o) => REVENUE_STATUSES.includes(o.status));
    let totalSales = 0;
    for (const order of salesOrders) {
      const multiplier = order.splitWithId ? 0.5 : 1;
      const orderNet = order.lineItems.reduce((sum, li) => sum + Number(li.netPrice), 0);
      totalSales += orderNet * multiplier;
    }

    const quoteOrders = monthOrders.filter((o) => o.status === "QUOTE");
    const quoteCount = quoteOrders.length;

    const convertedCount = monthOrders.filter(
      (o) => o.status === "ORDER" || o.status === "FULFILLED",
    ).length;

    const goal = yearlyGoal > 0 ? Math.round(yearlyGoal * monthlyWeights[m]) : 0;
    const variance = totalSales - goal;
    const variancePct = goal > 0 ? variance / goal : null;
    const bonus = variance > 0 && bonusRate > 0 ? Math.round(variance * bonusRate) : 0;
    const avgOrderValue = convertedCount > 0 ? totalSales / convertedCount : 0;
    const totalQuotable = convertedCount + quoteCount;
    const conversionRate = totalQuotable > 0 ? convertedCount / totalQuotable : null;

    months.push({
      month: m + 1,
      label: MONTH_LABELS[m],
      sales: Math.round(totalSales),
      goal,
      variance: Math.round(variance),
      variancePct,
      bonus,
      orderCount: convertedCount,
      avgOrderValue: Math.round(avgOrderValue),
      quoteCount,
      convertedCount,
      conversionRate,
    });
  }

  const ytdSales = months.reduce((sum, m) => sum + m.sales, 0);
  const ytdGoal = months.reduce((sum, m) => sum + m.goal, 0);
  const ytdOrders = months.reduce((sum, m) => sum + m.orderCount, 0);
  const ytdQuotes = months.reduce((sum, m) => sum + m.quoteCount, 0);
  const ytdVariance = ytdSales - ytdGoal;
  const ytdVariancePct = ytdGoal > 0 ? ytdVariance / ytdGoal : null;
  const ytdBonus = months.reduce((sum, m) => sum + m.bonus, 0);

  return {
    salesperson,
    year,
    yearlyGoal,
    bonusRate,
    months,
    totals: {
      sales: ytdSales,
      goal: ytdGoal,
      variance: ytdVariance,
      variancePct: ytdVariancePct,
      bonus: ytdBonus,
      orderCount: ytdOrders,
      quoteCount: ytdQuotes,
      conversionRate: ytdOrders + ytdQuotes > 0 ? ytdOrders / (ytdOrders + ytdQuotes) : null,
    },
  };
}
