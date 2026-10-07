// /app/src/lib/reports/topSellers.ts
//
// Top & bottom sellers: products ranked by units, revenue, or margin over a date
// range — the reorder / clear-out signal. Distinct from Inventory Health
// (never-sold / dead stock); this ranks products that actually sold. An optional
// department filter excludes non-merchandise lines (delivery, labor, freight) that
// would otherwise dominate. Ranked in the DB (GROUP BY + ORDER BY + LIMIT); dates
// and departments are bound params, metric and direction are validated enums so
// the dynamic ORDER BY is composed via Prisma.raw safely. Rule 33: cancelled
// OrderLineItem rows (SalesOrder.lineItems) excluded. Revenue scope:
// revenueStatusSql() — this ranking used to constrain the LINE status and
// nothing else, so a product quoted but never sold could outrank one that
// actually sold. netPrice/cost are LINE totals, summed directly.

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { revenueStatusSql } from "@/lib/reports/revenueScope";

export const TOP_SELLERS_METRICS = ["revenue", "units", "margin"] as const;
export type TopSellersMetric = (typeof TOP_SELLERS_METRICS)[number];

export interface TopSellerRow {
  productNumber: string | null;
  name: string;
  department: string;
  vendor: string;
  units: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
}

export interface TopSellersResult {
  metric: TopSellersMetric;
  startDate: string;
  endDate: string;
  limit: number;
  departments: string[]; // applied filter (empty = all)
  top: TopSellerRow[];
  bottom: TopSellerRow[];
}

export interface TopSellersInput {
  startDate: string;
  endDate: string;
  metric?: TopSellersMetric;
  limit?: number;
  departments?: string[];
}

// Exported so the pure mapper can be tested against realistic rows without a DB.
export interface TopSellerRawRow {
  product_number: string | null;
  name: string | null;
  department: string | null;
  vendor: string | null;
  units: number;
  revenue: number;
  cost: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const METRIC_SQL: Record<TopSellersMetric, Prisma.Sql> = {
  revenue: Prisma.raw('SUM(li."netPrice")'),
  units: Prisma.raw('SUM(li."orderedQuantity")'),
  margin: Prisma.raw('(SUM(li."netPrice") - SUM(li.cost))'),
};

/** Normalize untrusted input to a valid metric, a clamped 1-100 limit, and a
 * cleaned department list. Pure — unit-tested for the clamp + enum-guard. */
export function resolveTopSellersParams(input: TopSellersInput): {
  metric: TopSellersMetric;
  limit: number;
  departments: string[];
} {
  const metric: TopSellersMetric = TOP_SELLERS_METRICS.includes(input.metric as TopSellersMetric)
    ? (input.metric as TopSellersMetric)
    : "revenue";
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 25), 1), 100);
  const departments = (input.departments ?? []).filter((d) => d.trim().length > 0);
  return { metric, limit, departments };
}

export function mapTopSellerRow(r: TopSellerRawRow): TopSellerRow {
  const revenue = round2(Number(r.revenue) || 0);
  const cost = round2(Number(r.cost) || 0);
  const margin = round2(revenue - cost);
  return {
    productNumber: r.product_number,
    name: r.name ?? "(unnamed)",
    department: r.department ?? "Uncategorized",
    vendor: r.vendor ?? "No Vendor",
    units: Math.round(Number(r.units) || 0),
    revenue,
    cost,
    margin,
    marginPct: revenue > 0 ? round2((margin / revenue) * 100) : null,
  };
}

/**
 * The ranking a caller may ask for. A margin ranking orders products by margin,
 * so its order and membership give margin away even with the figures left out:
 * without "View cost" it is answered as a revenue ranking, and the response's
 * `metric` says so. Not refused: a refused query leaves the screen blank.
 */
export function topSellersMetricFor(
  metric: TopSellersMetric | undefined,
  showCost: boolean,
): TopSellersMetric | undefined {
  return !showCost && metric === "margin" ? "revenue" : metric;
}

type TopSellerRowForCaller = Omit<TopSellerRow, "cost" | "margin" | "marginPct">;

/** The rankings as a viewer without "View cost" receives them: no cost or margin. */
export interface TopSellersForCaller extends Omit<TopSellersResult, "top" | "bottom"> {
  top: TopSellerRowForCaller[];
  bottom: TopSellerRowForCaller[];
}

/**
 * The rankings for one viewer: whole for a holder of "View cost"; without cost,
 * margin and margin % for anyone else (pair with topSellersMetricFor, so the
 * ranking itself is not by margin). The response says which (`costVisible`).
 */
export function topSellersForCaller(
  result: TopSellersResult,
  showCost: boolean,
): (TopSellersResult | TopSellersForCaller) & { costVisible: boolean } {
  if (showCost) return { ...result, costVisible: true };
  const strip = (rows: TopSellerRow[]): TopSellerRowForCaller[] =>
    rows.map(({ productNumber, name, department, vendor, units, revenue }) => ({
      productNumber,
      name,
      department,
      vendor,
      units,
      revenue,
    }));
  return { ...result, top: strip(result.top), bottom: strip(result.bottom), costVisible: false };
}

export async function getTopSellers(
  prisma: PrismaClient,
  input: TopSellersInput,
): Promise<TopSellersResult> {
  const { metric, limit, departments } = resolveTopSellersParams(input);
  const { startDate, endDate } = input;

  const deptFilter =
    departments.length > 0 ? Prisma.sql`AND d.name = ANY(${departments}::text[])` : Prisma.empty;
  const metricCol = METRIC_SQL[metric];

  const query = (dir: Prisma.Sql) => Prisma.sql`
    SELECT p."productNumber" AS product_number,
           p.name AS name,
           COALESCE(d.name, 'Uncategorized') AS department,
           COALESCE(v.name, 'No Vendor') AS vendor,
           SUM(li."orderedQuantity")::float8 AS units,
           SUM(li."netPrice")::float8 AS revenue,
           SUM(li.cost)::float8 AS cost
    FROM "OrderLineItem" li
    JOIN "SalesOrder" so ON so.id = li."salesOrderId"
    JOIN "Product" p ON p.id = li."productId"
    LEFT JOIN "Department" d ON d.id = p."departmentId"
    LEFT JOIN "Vendor" v ON v.id = p."vendorId"
    WHERE ${revenueStatusSql()}
      AND so."orderDate" >= ${startDate}::date
      AND so."orderDate" < (${endDate}::date + INTERVAL '1 day')
      AND li."lineItemStatus" <> 'CANCELLED'
      ${deptFilter}
    GROUP BY p.id, p."productNumber", p.name, d.name, v.name
    HAVING SUM(li."orderedQuantity") > 0
    ORDER BY ${metricCol} ${dir}
    LIMIT ${limit}
  `;

  const [topRows, bottomRows] = await Promise.all([
    prisma.$queryRaw<TopSellerRawRow[]>(query(Prisma.raw("DESC"))),
    prisma.$queryRaw<TopSellerRawRow[]>(query(Prisma.raw("ASC"))),
  ]);

  return {
    metric,
    startDate,
    endDate,
    limit,
    departments,
    top: topRows.map(mapTopSellerRow),
    bottom: bottomRows.map(mapTopSellerRow),
  };
}
