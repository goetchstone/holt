// /app/src/lib/reports/topSellers.ts
//
// Top & bottom sellers: products ranked by units, revenue, or margin over a date
// range — the reorder / clear-out signal. Distinct from Inventory Health
// (never-sold / dead stock); this ranks products that actually sold. An optional
// department filter excludes non-merchandise lines (delivery, labor, freight) that
// would otherwise dominate. Ranked in the DB (GROUP BY + ORDER BY + LIMIT); dates
// and departments are bound params, metric and direction are validated enums so
// the dynamic ORDER BY is composed via Prisma.raw safely. Rule 33: cancelled
// OrderLineItem rows (SalesOrder.lineItems) excluded; netPrice/cost are LINE
// totals, summed directly.

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

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
    WHERE so."orderDate" >= ${startDate}::date
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
