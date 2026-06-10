// /app/src/lib/reports/designerDashboard.ts
//
// Designer performance dashboard: sales, quotes, and house call metrics for one
// salesperson with MTD/YTD comparisons to the prior year. Extracted from the
// Pages API so the App Router page + tRPC procedure share one source of truth.
// The caller-vs-requested salesperson authorization stays in the tRPC procedure
// (it needs the session); this lib takes an already-resolved salesperson name.
//
// Per-category breakdown groups by Furniture (furniture + outdoor depts),
// Window Treatments (curtains), Rugs, and Home Shop (everything else). Apparel +
// accessories don't fit any of these designer categories so they're skipped from
// the per-category buckets -- but they DO count toward the "All" total so the
// total reconciles to Sales by Salesperson + Monthly Performance for the same
// person + period (user direction 2026-04-30: "we should not be excluding
// anything but freight").
//
// CLAUDE.md rule 33 + RETURNED included (returns carry negative line items that
// reduce the total to match FileMaker reporting).

import type { PrismaClient } from "@prisma/client";
import { buildLineItemWhere } from "@/lib/salesBySalesperson";
import { getDateRanges, type PeriodRange } from "@/lib/reports/dateRanges";

const CATEGORY_DEPARTMENT_MAP: Record<string, string[]> = {
  Furniture: ["furniture", "outdoor furniture"],
  "Window Treatments": ["curtains", "window"],
  Rugs: ["rugs", "rug"],
  "Home Shop": [],
};

const EXCLUDED_DEPARTMENTS = ["apparel", "mens apparel", "womens apparel", "accessories"];

const CATEGORIES = ["Furniture", "Window Treatments", "Rugs", "Home Shop"];

// Sales: ORDER, FULFILLED, or RETURNED (returns have negative line items that
// must reduce the salesperson's total to match FileMaker reporting).
const REVENUE_STATUSES = ["ORDER", "FULFILLED", "RETURNED"];

// Revenue attribution window + conversion threshold for house calls.
const HC_BEFORE_DAYS = 30;
const HC_AFTER_DAYS = 90;
const HC_CONVERSION_THRESHOLD = 1000;

export interface CategoryRow {
  category: string;
  mtdValue: number;
  prevMtdValue: number;
  mtdVar: number | null;
  ytdValue: number;
  prevYtdValue: number;
  ytdVar: number | null;
}

export interface DesignerDashboardResponse {
  salesperson: string;
  currentYear: number;
  prevYear: number;
  periods: {
    mtd: { start: string; end: string };
    ytd: { start: string; end: string };
    prevMtd: { start: string; end: string };
    prevYtd: { start: string; end: string };
  };
  sales: {
    rows: CategoryRow[];
    annualizedSales: number;
    orderCount: number;
    avgOrderValue: number;
    avgMargin: number;
  };
  quotes: {
    rows: CategoryRow[];
    quoteCount: number;
    convertedCount: number;
    conversionRate: number;
    avgQuoteValue: number;
    openQuoteValue: number;
  };
  houseCalls: {
    mtd: number;
    prevMtd: number;
    mtdVar: number | null;
    ytd: number;
    prevYtd: number;
    ytdVar: number | null;
    avgQuoteValue: number;
    convertedCount: number;
    conversionRate: number;
    totalSalesValue: number;
    avgSaleValue: number;
  };
}

export interface DesignerDashboardParams {
  salesperson: string;
  asOf?: string;
}

export interface CategoryMetrics {
  revenue: number;
  cost: number;
  count: number;
}

function emptyMetrics(): CategoryMetrics {
  return { revenue: 0, cost: 0, count: 0 };
}

function variance(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 1 : null;
  return (current - previous) / previous;
}

function getCategoryForDepartment(deptName: string | null): string {
  if (!deptName) return "Home Shop";
  const lower = deptName.toLowerCase();

  if (EXCLUDED_DEPARTMENTS.some((ex) => lower.includes(ex))) return "__excluded__";

  for (const [category, keywords] of Object.entries(CATEGORY_DEPARTMENT_MAP)) {
    if (category === "Home Shop") continue;
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "Home Shop";
}

// netPrice AND cost are both extended LINE totals (already multiplied by qty)
// -- the same invariant journalEntry.ts, grossMargin.ts, and every other reader
// relies on. Never multiply either by orderedQuantity. Split orders credit 50%.
export interface DashboardLineItem {
  netPrice: unknown;
  cost: unknown;
  orderedQuantity: unknown;
  product: { department: { name: string | null } | null } | null;
}

interface DashboardOrder {
  orderDate: Date | null;
  status: string;
  splitWithId: number | null;
  lineItems: DashboardLineItem[];
}

// Order has a split — both the primary and the split partner get 50%.
function creditMultiplier(order: { splitWithId: number | null }): number {
  return order.splitWithId ? 0.5 : 1;
}

function isInPeriod(orderDate: Date | null, period: PeriodRange): boolean {
  if (!orderDate) return false;
  const ts = new Date(orderDate).getTime();
  return ts >= period.start.getTime() && ts < period.end.getTime();
}

// Per-category buckets exclude apparel + accessories (they're not Designer
// categories). The "All" total includes EVERY line so the total reconciles to
// Sales by Salesperson + Monthly Performance. Non-merchandise pass-through codes
// (DELIVERY CHARGE / HD-FREIGHT / LABOR-HD) are already filtered at the line-item
// where clause.
export function accumulateLineItem(
  result: Record<string, CategoryMetrics>,
  li: DashboardLineItem,
  multiplier: number,
): void {
  const deptName = li.product?.department?.name || null;
  const category = getCategoryForDepartment(deptName);

  const revenue = Number(li.netPrice) * multiplier;
  // cost is the LINE total (sister invariant to netPrice) -- multiplying by
  // orderedQuantity here double-counted COGS for every multi-qty line.
  const cost = Number(li.cost) * multiplier;

  if (category !== "__excluded__" && result[category]) {
    result[category].revenue += revenue;
    result[category].cost += cost;
    result[category].count += 1;
  }
  result["All"].revenue += revenue;
  result["All"].cost += cost;
  result["All"].count += 1;
}

function processOrders(
  orders: DashboardOrder[],
  period: PeriodRange,
): Record<string, CategoryMetrics> {
  const result: Record<string, CategoryMetrics> = {};
  CATEGORIES.forEach((c) => (result[c] = emptyMetrics()));
  result["All"] = emptyMetrics();

  for (const order of orders) {
    if (!isInPeriod(order.orderDate, period)) continue;
    const multiplier = creditMultiplier(order);
    for (const li of order.lineItems) {
      accumulateLineItem(result, li, multiplier);
    }
  }
  return result;
}

function countOrders(orders: { orderDate: Date | null }[], period: PeriodRange): number {
  return orders.filter((o) => isInPeriod(o.orderDate, period)).length;
}

function buildOrderMatchClause(matchNames: string[], staffId: number | null) {
  return [
    ...matchNames.map((name) => ({
      salesperson: { equals: name, mode: "insensitive" as const },
    })),
    ...(staffId !== null ? [{ salesPersonId: staffId }] : []),
    ...(staffId !== null ? [{ splitWithId: staffId }] : []),
  ];
}

function buildCategoryRows(
  salesMtd: Record<string, CategoryMetrics>,
  mtd: Record<string, CategoryMetrics>,
  prevMtd: Record<string, CategoryMetrics>,
  ytd: Record<string, CategoryMetrics>,
  prevYtd: Record<string, CategoryMetrics>,
): CategoryRow[] {
  return ["All", ...CATEGORIES].map((cat) => ({
    category: cat === "All" ? (mtd === salesMtd ? "All Sales" : "All Quotes") : cat,
    mtdValue: mtd[cat]?.revenue || 0,
    prevMtdValue: prevMtd[cat]?.revenue || 0,
    mtdVar: variance(mtd[cat]?.revenue || 0, prevMtd[cat]?.revenue || 0),
    ytdValue: ytd[cat]?.revenue || 0,
    prevYtdValue: prevYtd[cat]?.revenue || 0,
    ytdVar: variance(ytd[cat]?.revenue || 0, prevYtd[cat]?.revenue || 0),
  }));
}

interface HouseCallOrder {
  orderDate: Date | null;
  customerId: number | null;
}

function countHouseCalls(hcOrders: HouseCallOrder[], period: PeriodRange): number {
  return hcOrders.filter((o) => isInPeriod(o.orderDate, period)).length;
}

interface HcWindow {
  customerId: number;
  start: Date;
  end: Date;
}

// Build attribution windows: customerId + [-30d, +90d] window from each house
// call dated inside the current YTD period.
function buildHcWindows(hcYtdCalls: HouseCallOrder[]): HcWindow[] {
  const hcWindows: HcWindow[] = [];
  for (const hc of hcYtdCalls) {
    if (!hc.customerId) continue;
    if (!hc.orderDate) continue;
    const callDate = new Date(hc.orderDate);
    const windowStart = new Date(callDate);
    windowStart.setDate(windowStart.getDate() - HC_BEFORE_DAYS);
    const windowEnd = new Date(callDate);
    windowEnd.setDate(windowEnd.getDate() + HC_AFTER_DAYS);
    hcWindows.push({ customerId: hc.customerId, start: windowStart, end: windowEnd });
  }
  return hcWindows;
}

interface FollowUpOrder {
  orderDate: Date | null;
  status: string;
  customerId: number | null;
  lineItems: { netPrice: unknown }[];
  splitWith: { id: number } | null;
}

// Sum follow-up sales that land inside a house-call window and clear the
// conversion threshold. Returns the attributed total + the converted count.
function attributeFollowUpSales(
  followUpOrders: FollowUpOrder[],
  hcWindows: HcWindow[],
): { totalSalesValue: number; convertedCount: number } {
  let totalSalesValue = 0;
  let convertedCount = 0;

  for (const order of followUpOrders) {
    if (!order.orderDate) continue;
    if (order.status === "RETURNED") continue;
    const orderDate = new Date(order.orderDate);
    const inWindow = hcWindows.some(
      (w) => order.customerId === w.customerId && orderDate >= w.start && orderDate <= w.end,
    );
    if (!inWindow) continue;

    const rawValue = order.lineItems.reduce((sum, li) => sum + Number(li.netPrice), 0);
    const multiplier = order.splitWith ? 0.5 : 1;
    const orderValue = rawValue * multiplier;
    if (orderValue < HC_CONVERSION_THRESHOLD) continue;
    totalSalesValue += orderValue;
    convertedCount += 1;
  }
  return { totalSalesValue, convertedCount };
}

export async function getDesignerDashboard(
  prisma: PrismaClient,
  params: DesignerDashboardParams,
): Promise<DesignerDashboardResponse> {
  const salesperson = params.salesperson;
  const ranges = getDateRanges(params.asOf);

  // Resolve the salesperson to a StaffMember row (incl. aliases) so we can
  // OR-match across (FK + displayName + every alias). Issue #274 — Sandy's row
  // has displayName='Sandy' but her POS-imported orders carry
  // `salesperson='Sandra Matheny'`; aliases close that gap without renaming the
  // up-board record.
  const staffRecord = await prisma.staffMember.findFirst({
    where: { displayName: { equals: salesperson, mode: "insensitive" } },
    select: { id: true, displayName: true, aliases: true },
  });
  const staffId = staffRecord?.id ?? null;
  const matchNames = [
    salesperson,
    ...(staffRecord?.aliases ?? []).filter((a) => a.toLowerCase() !== salesperson.toLowerCase()),
  ];
  const orderMatch = buildOrderMatchClause(matchNames, staffId);

  // Fetch orders where this person is either the primary salesperson (by string
  // match against displayName + any aliases) OR the split partner (by FK). This
  // ensures split orders appear in both dashboards.
  const allOrders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: ranges.prevYtd.start, lt: ranges.ytd.end },
      OR: orderMatch,
    },
    include: {
      lineItems: {
        // Excludes cancelled lines (rule 33) and the delivery + freight
        // pass-throughs. Labor stays included.
        where: buildLineItemWhere([], false),
        include: {
          product: {
            include: {
              department: true,
            },
          },
        },
      },
    },
  });

  const salesOrders = allOrders.filter((o) => REVENUE_STATUSES.includes(o.status));
  const salesMtd = processOrders(salesOrders, ranges.mtd);
  const salesPrevMtd = processOrders(salesOrders, ranges.prevMtd);
  const salesYtd = processOrders(salesOrders, ranges.ytd);
  const salesPrevYtd = processOrders(salesOrders, ranges.prevYtd);
  const activeOrders = allOrders.filter((o) => o.status === "ORDER" || o.status === "FULFILLED");
  const orderCountYtd = countOrders(activeOrders, ranges.ytd);

  // Annualized: YTD revenue / (days elapsed / 365)
  const daysElapsed = Math.max(
    1,
    Math.ceil((ranges.ytd.end.getTime() - ranges.ytd.start.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const annualizedSales = (salesYtd["All"].revenue / daysElapsed) * 365;

  const avgOrderValue = orderCountYtd > 0 ? salesYtd["All"].revenue / orderCountYtd : 0;

  const avgMargin =
    salesYtd["All"].revenue > 0
      ? (salesYtd["All"].revenue - salesYtd["All"].cost) / salesYtd["All"].revenue
      : 0;

  // QUOTES panel — owner rule 2026-05-19: every sale counts as a converted quote
  // for reporting purposes, including same-day walk-ins that skip the explicit
  // quote step in the POS. So "quote-equivalent activity" = open quotes + closed
  // sales. Without this, the prev-year MTD column shows $0 for every designer
  // because last year's quotes have all converted or expired by today, and the
  // POS's sales CSV doesn't export quoteCode so we can't filter by quote-origin.
  // This filter mirrors the user's actual workflow: every order is
  // quote-equivalent work the designer produced.
  const quoteOrders = allOrders.filter(
    (o) => o.status === "QUOTE" || o.status === "ORDER" || o.status === "FULFILLED",
  );
  const quotesMtd = processOrders(quoteOrders, ranges.mtd);
  const quotesPrevMtd = processOrders(quoteOrders, ranges.prevMtd);
  const quotesYtd = processOrders(quoteOrders, ranges.ytd);
  const quotesPrevYtd = processOrders(quoteOrders, ranges.prevYtd);
  const quoteCountYtd = countOrders(quoteOrders, ranges.ytd);

  // Conversion rate: closed sales / total quote-equivalent activity. Since
  // quoteCountYtd now includes the converted ones, the denominator is total
  // written (open + closed) — no double-counting.
  const convertedCount = orderCountYtd;
  const conversionRate = quoteCountYtd > 0 ? convertedCount / quoteCountYtd : 0;

  const avgQuoteValue = quoteCountYtd > 0 ? quotesYtd["All"].revenue / quoteCountYtd : 0;

  // Open Quotes Value — still strictly status=QUOTE (the in-flight set the
  // designer needs to close). Computed separately so this card remains
  // meaningful even with the broader QUOTES panel above.
  const openQuoteOrders = allOrders.filter((o) => o.status === "QUOTE");
  const openQuotesYtd = processOrders(openQuoteOrders, ranges.ytd);
  const openQuoteValue = openQuotesYtd["All"].revenue;

  // House calls: a DC250 line item on an order = one house call. Revenue
  // attribution: sales to that customer from 30 days before through 90 days
  // after the call. Only orders over $1,000 count as conversions.
  const hcOrders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: ranges.prevYtd.start, lt: ranges.ytd.end },
      OR: orderMatch,
      lineItems: {
        some: {
          partNo: { in: ["DC250", "DC-250", "DC 250"] },
          lineItemStatus: { not: "CANCELLED" },
        },
      },
    },
    select: {
      id: true,
      orderDate: true,
      customerId: true,
    },
  });

  const hcMtd = countHouseCalls(hcOrders, ranges.mtd);
  const hcPrevMtd = countHouseCalls(hcOrders, ranges.prevMtd);
  const hcYtd = countHouseCalls(hcOrders, ranges.ytd);
  const hcPrevYtd = countHouseCalls(hcOrders, ranges.prevYtd);

  const hcYtdCalls = hcOrders.filter((o) => isInPeriod(o.orderDate, ranges.ytd));
  const hcWindows = buildHcWindows(hcYtdCalls);
  const hcCustomerIds = [...new Set(hcWindows.map((w) => w.customerId))];

  let hcTotalSalesValue = 0;
  let hcConvertedCount = 0;

  if (hcCustomerIds.length > 0) {
    const followUpOrders = await prisma.salesOrder.findMany({
      where: {
        customerId: { in: hcCustomerIds },
        status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
        OR: orderMatch,
      },
      include: {
        lineItems: {
          where: buildLineItemWhere([], false),
        },
        splitWith: { select: { id: true } },
      },
    });

    const attributed = attributeFollowUpSales(followUpOrders, hcWindows);
    hcTotalSalesValue = attributed.totalSalesValue;
    hcConvertedCount = attributed.convertedCount;
  }

  const avgHcSaleValue = hcYtdCalls.length > 0 ? hcTotalSalesValue / hcYtdCalls.length : 0;

  return {
    salesperson,
    currentYear: ranges.currentYear,
    prevYear: ranges.prevYear,
    // Date bounds used for each period (ISO strings for debugging).
    periods: {
      mtd: { start: ranges.mtd.start.toISOString(), end: ranges.mtd.end.toISOString() },
      ytd: { start: ranges.ytd.start.toISOString(), end: ranges.ytd.end.toISOString() },
      prevMtd: {
        start: ranges.prevMtd.start.toISOString(),
        end: ranges.prevMtd.end.toISOString(),
      },
      prevYtd: {
        start: ranges.prevYtd.start.toISOString(),
        end: ranges.prevYtd.end.toISOString(),
      },
    },
    sales: {
      rows: buildCategoryRows(salesMtd, salesMtd, salesPrevMtd, salesYtd, salesPrevYtd),
      annualizedSales,
      orderCount: orderCountYtd,
      avgOrderValue,
      avgMargin,
    },
    quotes: {
      rows: buildCategoryRows(salesMtd, quotesMtd, quotesPrevMtd, quotesYtd, quotesPrevYtd),
      quoteCount: quoteCountYtd,
      convertedCount,
      conversionRate,
      avgQuoteValue,
      openQuoteValue,
    },
    houseCalls: {
      mtd: hcMtd,
      prevMtd: hcPrevMtd,
      mtdVar: variance(hcMtd, hcPrevMtd),
      ytd: hcYtd,
      prevYtd: hcPrevYtd,
      ytdVar: variance(hcYtd, hcPrevYtd),
      avgQuoteValue: avgHcSaleValue,
      convertedCount: hcConvertedCount,
      conversionRate: hcYtdCalls.length > 0 ? hcConvertedCount / hcYtdCalls.length : 0,
      totalSalesValue: hcTotalSalesValue,
      avgSaleValue: avgHcSaleValue,
    },
  };
}
