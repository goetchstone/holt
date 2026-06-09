// /app/src/lib/reports/grossMargin.ts
//
// Gross margin (revenue - cost) by department or vendor for a date range.
// Aggregated in the DB (GROUP BY) to stay under Postgres's 65k bind-param limit
// (P2029) at scale; dates are bound params and the pivot picks server-controlled
// SQL fragments (no injection). Rule 33: cancelled OrderLineItem rows
// (SalesOrder.lineItems) excluded. netPrice/cost are LINE totals — summed
// directly, never multiplied. Query + row-shaping split so summarizeGrossMargin is
// unit-tested without a DB.

import { Prisma, type PrismaClient } from "@prisma/client";

export const GROSS_MARGIN_PIVOTS = ["department", "vendor"] as const;
export type GrossMarginPivot = (typeof GROSS_MARGIN_PIVOTS)[number];

export interface GrossMarginRow {
  key: string; // department name or vendor name
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null; // null when revenue is 0 (can't divide)
  units: number;
  lineCount: number;
}

export interface GrossMarginTotals {
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  units: number;
  lineCount: number;
}

export interface GrossMarginResult {
  pivot: GrossMarginPivot;
  startDate: string;
  endDate: string;
  rows: GrossMarginRow[];
  totals: GrossMarginTotals;
}

export interface GrossMarginInput {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string; // YYYY-MM-DD inclusive
  pivot?: GrossMarginPivot;
}

// One raw aggregated row as returned by the GROUP BY. Exported so the pure
// summarizer can be tested against realistic input without a database.
export interface GrossMarginRawRow {
  key: string | null;
  revenue: number;
  cost: number;
  units: number;
  line_count: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const marginPct = (margin: number, revenue: number): number | null =>
  revenue > 0 ? round2((margin / revenue) * 100) : null;

/**
 * Shape raw GROUP BY rows into the report result: round money to cents, derive
 * margin + margin %, sort by margin dollars (where profit comes from), and total
 * the period. Pure — no I/O — so every branch is unit-tested.
 */
export function summarizeGrossMargin(
  raw: GrossMarginRawRow[],
  meta: { pivot: GrossMarginPivot; startDate: string; endDate: string },
): GrossMarginResult {
  const rows: GrossMarginRow[] = raw.map((r) => {
    const revenue = round2(Number(r.revenue) || 0);
    const cost = round2(Number(r.cost) || 0);
    const margin = round2(revenue - cost);
    return {
      key: r.key ?? "Uncategorized",
      revenue,
      cost,
      margin,
      marginPct: marginPct(margin, revenue),
      units: Math.round(Number(r.units) || 0),
      lineCount: Number(r.line_count) || 0,
    };
  });

  // Sort by margin dollars, descending (largest profit contributors first).
  rows.sort((a, b) => b.margin - a.margin);

  const sums = rows.reduce(
    (acc, r) => {
      acc.revenue += r.revenue;
      acc.cost += r.cost;
      acc.units += r.units;
      acc.lineCount += r.lineCount;
      return acc;
    },
    { revenue: 0, cost: 0, units: 0, lineCount: 0 },
  );
  const totalRevenue = round2(sums.revenue);
  const totalCost = round2(sums.cost);
  const totalMargin = round2(totalRevenue - totalCost);

  return {
    pivot: meta.pivot,
    startDate: meta.startDate,
    endDate: meta.endDate,
    rows,
    totals: {
      revenue: totalRevenue,
      cost: totalCost,
      margin: totalMargin,
      marginPct: marginPct(totalMargin, totalRevenue),
      units: sums.units,
      lineCount: sums.lineCount,
    },
  };
}

export async function getGrossMargin(
  prisma: PrismaClient,
  input: GrossMarginInput,
): Promise<GrossMarginResult> {
  const pivot: GrossMarginPivot = input.pivot === "vendor" ? "vendor" : "department";
  const { startDate, endDate } = input;

  // The pivot picks two server-controlled SQL fragments — the grouping key
  // expression and the dimension join. No user data flows into them.
  const isVendor = pivot === "vendor";
  const keyExpr = isVendor
    ? Prisma.sql`COALESCE(v.name, 'No Vendor')`
    : Prisma.sql`COALESCE(d.name, 'Uncategorized')`;
  const dimJoin = isVendor
    ? Prisma.sql`LEFT JOIN "Vendor" v ON v.id = p."vendorId"`
    : Prisma.sql`LEFT JOIN "Department" d ON d.id = p."departmentId"`;

  // endDate is inclusive: compare against (endDate + 1 day) so the whole final day
  // counts regardless of the order's time component. Dates are bound parameters.
  const rawRows = await prisma.$queryRaw<GrossMarginRawRow[]>(Prisma.sql`
    SELECT ${keyExpr} AS key,
           SUM(li."netPrice")::float8 AS revenue,
           SUM(li.cost)::float8 AS cost,
           SUM(li."orderedQuantity")::float8 AS units,
           COUNT(*)::int AS line_count
    FROM "OrderLineItem" li
    JOIN "SalesOrder" so ON so.id = li."salesOrderId"
    LEFT JOIN "Product" p ON p.id = li."productId"
    ${dimJoin}
    WHERE so."orderDate" >= ${startDate}::date
      AND so."orderDate" < (${endDate}::date + INTERVAL '1 day')
      AND li."lineItemStatus" <> 'CANCELLED'
    GROUP BY 1
  `);

  return summarizeGrossMargin(rawRows, { pivot, startDate, endDate });
}
