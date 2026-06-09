// /app/src/pages/api/dashboard/weekly.ts
//
// Backs two surfaces:
//   - /reports/dashboard (no startDate → current week, legacy behavior)
//   - /reports/weekly-summary (passes startDate + wow=1 → Sunday-aligned
//     week with same-week-last-year + foot-traffic comparison)
//
// The week-over-week extras only fire when wow=1, so the legacy
// dashboard's contract is unchanged.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getMonth, getYear, getDaysInMonth, differenceInDays, addDays } from "date-fns";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  startOfRetailWeek,
  lastCompleteWeekStart,
  weekEnd,
  weekEndExclusive,
  sameWeekLastYear,
  formatWeekRange,
  formatYmd,
} from "@/lib/weekOverWeek";
import { visitorsByStoreLocation } from "@/lib/storeTraffic";
import { buildRows } from "@/lib/weeklySummaryRows";
import { logError } from "@/lib/logger";

const SALES_STATUSES = ["ORDER", "FULFILLED", "RETURNED"] as const;

const getMonthName = (monthIndex: number) => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return months[monthIndex];
};

/**
 * Net sales per entity (store / department / supplier) for the
 * inclusive window [startDate, endDate]. Company groups by store
 * location; department/supplier group by the product's taxonomy.
 */
async function groupSales(
  startDate: Date,
  endDate: Date,
  typeParam: string,
  deptFilter: string[],
): Promise<Map<string, number>> {
  const grouped = new Map<string, number>();

  if (typeParam === "company") {
    const storeGroups = await prisma.orderLineItem.findMany({
      where: {
        salesOrder: {
          orderDate: { gte: startDate, lte: endDate },
          status: { in: [...SALES_STATUSES] },
        },
        product: { department: { name: { in: deptFilter } } },
      },
      select: {
        netPrice: true,
        salesOrder: { select: { storeLocation: true, store: { select: { name: true } } } },
      },
    });
    for (const item of storeGroups) {
      const entityName = item.salesOrder.store?.name || item.salesOrder.storeLocation || "Unknown";
      grouped.set(entityName, (grouped.get(entityName) ?? 0) + Number(item.netPrice || 0));
    }
    return grouped;
  }

  const sales = await prisma.orderLineItem.groupBy({
    by: ["productId"],
    where: {
      salesOrder: {
        orderDate: { gte: startDate, lte: endDate },
        status: { in: [...SALES_STATUSES] },
      },
      product: { department: { name: { in: deptFilter } } },
    },
    _sum: { netPrice: true },
  });

  const productIds = sales.map((s) => s.productId).filter((id): id is number => id !== null);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      vendor: { select: { name: true } },
      department: { select: { name: true } },
    },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const sale of sales) {
    if (sale.productId === null) continue;
    const product = productMap.get(sale.productId);
    if (!product) continue;
    const entityName =
      typeParam === "supplier" ? product.vendor?.name || "N/A" : product.department?.name || "N/A";
    grouped.set(entityName, (grouped.get(entityName) ?? 0) + Number(sale._sum.netPrice || 0));
  }
  return grouped;
}

/**
 * Distinct sales transactions per store for [startDate, endDate]. Used
 * for the conversion rate (transactions ÷ door visitors). Counts ORDER
 * + FULFILLED orders only (a RETURNED order isn't a conversion) and is
 * NOT department-filtered — door traffic is whole-store, so conversion
 * compares whole-store transactions against whole-store visitors. Keyed
 * by the same entity name the company sales grouping uses.
 */
async function transactionsByStore(
  startDate: Date,
  endDate: Date,
): Promise<Record<string, number>> {
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: startDate, lte: endDate },
      status: { in: ["ORDER", "FULFILLED"] },
    },
    select: { storeLocation: true, store: { select: { name: true } } },
  });
  const counts: Record<string, number> = {};
  for (const o of orders) {
    const key = o.store?.name || o.storeLocation || "Unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

interface WeekWindow {
  startDate: Date;
  endDate: Date;
  lyStart: Date;
  lyEnd: Date;
}

/** Resolve the report window. wow snaps to a Sunday week (default: last
 *  complete week); legacy keeps its raw startDate / today. */
function resolveWeekWindow(wow: boolean, selectedStartDate: string | undefined): WeekWindow {
  let startDate: Date;
  if (wow && selectedStartDate) {
    startDate = startOfRetailWeek(new Date(`${selectedStartDate}T00:00:00Z`));
  } else if (wow) {
    startDate = lastCompleteWeekStart(new Date());
  } else if (selectedStartDate) {
    startDate = new Date(selectedStartDate);
  } else {
    startDate = new Date();
  }
  const endDate = wow ? weekEnd(startDate) : addDays(startDate, 6);
  const lyStart = sameWeekLastYear(startDate);
  return { startDate, endDate, lyStart, lyEnd: weekEnd(lyStart) };
}

interface Comparisons {
  thisWeek: Map<string, number>;
  lastYear: Map<string, number>;
  trafficThis: Record<string, number>;
  trafficLast: Record<string, number>;
  transThis: Record<string, number>;
  transLast: Record<string, number>;
}

/** This week's sales + (wow only) last year's sales, foot traffic, and
 *  transaction counts (for conversion). */
async function loadComparisons(
  wow: boolean,
  typeParam: string,
  deptFilter: string[],
  win: WeekWindow,
): Promise<Comparisons> {
  const emptyMap = Promise.resolve(new Map<string, number>());
  const emptyRec = Promise.resolve<Record<string, number>>({});
  const [thisWeek, lastYear, trafficThis, trafficLast, transThis, transLast] = await Promise.all([
    groupSales(win.startDate, win.endDate, typeParam, deptFilter),
    wow ? groupSales(win.lyStart, win.lyEnd, typeParam, deptFilter) : emptyMap,
    wow ? visitorsByStoreLocation(win.startDate, weekEndExclusive(win.startDate)) : emptyRec,
    wow ? visitorsByStoreLocation(win.lyStart, weekEndExclusive(win.lyStart)) : emptyRec,
    wow ? transactionsByStore(win.startDate, win.endDate) : emptyRec,
    wow ? transactionsByStore(win.lyStart, win.lyEnd) : emptyRec,
  ]);
  return { thisWeek, lastYear, trafficThis, trafficLast, transThis, transLast };
}

/** Week-over-week response extras (labels + traffic totals), or {} legacy. */
function buildWowExtras(wow: boolean, win: WeekWindow, cmp: Comparisons) {
  if (!wow) return {};
  const sum = (rec: Record<string, number>) => Object.values(rec).reduce((s, v) => s + v, 0);
  return {
    weekLabel: formatWeekRange(win.startDate),
    lastYear: {
      weekStart: formatYmd(win.lyStart),
      weekEnd: formatYmd(win.lyEnd),
      label: formatWeekRange(win.lyStart),
    },
    traffic: {
      totalThisWeek: sum(cmp.trafficThis),
      totalLastYear: sum(cmp.trafficLast),
      byStoreThisWeek: cmp.trafficThis,
      byStoreLastYear: cmp.trafficLast,
    },
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  try {
    const typeParam = (req.query.type as string)?.toLowerCase() || "company";
    const departmentsQuery = (req.query.departments as string)?.split(",").filter(Boolean);
    const selectedStartDate = req.query.startDate as string | undefined;
    const wow = req.query.wow === "1"; // week-over-week mode (weekly-summary)

    const win = resolveWeekWindow(wow, selectedStartDate);
    const reportDays = differenceInDays(win.endDate, win.startDate) + 1;
    const reportYear = getYear(win.startDate);
    const reportMonthName = getMonthName(getMonth(win.startDate));
    const daysInMonth = getDaysInMonth(win.startDate);

    const distinctDepartments = await prisma.orderLineItem.findMany({
      where: {
        salesOrder: {
          orderDate: { gte: win.startDate, lte: win.endDate },
          status: { in: [...SALES_STATUSES] },
        },
      },
      select: { product: { select: { department: { select: { name: true } } } } },
      distinct: ["productId"],
    });
    const availableDepartments = [
      ...new Set(
        distinctDepartments.map((d) => d.product?.department?.name).filter((d): d is string => !!d),
      ),
    ].sort((a, b) => a.localeCompare(b));

    const deptFilter =
      departmentsQuery && departmentsQuery.length > 0 ? departmentsQuery : availableDepartments;

    const cmp = await loadComparisons(wow, typeParam, deptFilter, win);

    const goals = await prisma.salesGoals.findMany({
      where: { year: reportYear, goalType: { equals: typeParam, mode: "insensitive" } },
    });
    const annualGoals = new Map(goals.map((g) => [g.entityName, g.annualGoal]));
    const monthlyPercentage = await prisma.monthlySalesPercentage.findUnique({
      where: { year_month: { year: reportYear, month: reportMonthName } },
    });
    const monthPercent = monthlyPercentage ? monthlyPercentage.percentage / 100 : 0;

    // Entity set = this week, unioned with last year when comparing so a
    // store/dept that sold last year but not this week still shows (as a drop).
    const entityNames = new Set<string>(cmp.thisWeek.keys());
    if (wow) for (const k of cmp.lastYear.keys()) entityNames.add(k);

    const rows = buildRows({
      entityNames,
      thisWeek: cmp.thisWeek,
      lastYear: cmp.lastYear,
      annualGoals,
      monthPercent,
      daysInMonth,
      reportDays,
      wow,
      typeParam,
      trafficThis: cmp.trafficThis,
      trafficLast: cmp.trafficLast,
      transThis: cmp.transThis,
      transLast: cmp.transLast,
    });

    return res.status(200).json({
      weekStart: formatYmd(win.startDate),
      weekEnd: formatYmd(win.endDate),
      rows,
      availableDepartments,
      ...buildWowExtras(wow, win, cmp),
    });
  } catch (e) {
    logError("Dashboard weekly API error", e);
    res.status(500).json({ error: "Dashboard query failed" });
  }
}
