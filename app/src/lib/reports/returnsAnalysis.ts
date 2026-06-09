// /app/src/lib/reports/returnsAnalysis.ts
//
// Returns analysis: return rate by department or vendor over a date range, plus
// the most-returned products. A "return" = a line on a RETURNED SalesOrder; those
// carry negative netPrice (the credit), so returns value is its magnitude, gross =
// positive netPrice on ORDER + FULFILLED. Rate = returns / gross, period-over-
// period (not cohort-matched — the standard retail approximation). Aggregated in
// the DB (GROUP BY); dates bound, pivot a validated enum. Rule 33: cancelled
// OrderLineItem rows (SalesOrder.lineItems) excluded; netPrice is a LINE total.

import type { PrismaClient } from "@prisma/client";

export const RETURNS_PIVOTS = ["department", "vendor"] as const;
export type ReturnsPivot = (typeof RETURNS_PIVOTS)[number];

export interface ReturnsRow {
  key: string;
  grossSales: number;
  returns: number; // positive magnitude
  returnRate: number | null; // returns / grossSales * 100; null when gross 0
  returnedUnits: number;
}

export interface ReturnedProduct {
  productNumber: string | null;
  name: string;
  returns: number; // positive magnitude
  returnedUnits: number;
}

export interface ReturnsResult {
  pivot: ReturnsPivot;
  startDate: string;
  endDate: string;
  totals: { grossSales: number; returns: number; returnRate: number | null; returnedUnits: number };
  rows: ReturnsRow[];
  topReturnedProducts: ReturnedProduct[];
}

export interface ReturnsInput {
  startDate: string;
  endDate: string;
  pivot?: ReturnsPivot;
}

// Exported so the pure summarizer can be tested against realistic rows without a DB.
export interface ReturnsRawGroupRow {
  key: string | null;
  gross: number | null;
  returns_net: number | null;
  returned_units: number | null;
}

export interface ReturnsRawProductRow {
  product_number: string | null;
  name: string | null;
  returns_net: number | null;
  returned_units: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const rate = (returns: number, gross: number): number | null =>
  gross > 0 ? round2((returns / gross) * 100) : null;

export async function getReturnsAnalysis(
  prisma: PrismaClient,
  input: ReturnsInput,
): Promise<ReturnsResult> {
  const pivot: ReturnsPivot = input.pivot === "vendor" ? "vendor" : "department";
  const { startDate, endDate } = input;

  const groupRows =
    pivot === "vendor"
      ? await prisma.$queryRaw<ReturnsRawGroupRow[]>`
          SELECT COALESCE(v.name, 'No Vendor') AS key,
                 SUM(li."netPrice") FILTER (WHERE so.status IN ('ORDER', 'FULFILLED'))::float8 AS gross,
                 SUM(li."netPrice") FILTER (WHERE so.status = 'RETURNED')::float8 AS returns_net,
                 SUM(li."orderedQuantity") FILTER (WHERE so.status = 'RETURNED')::float8 AS returned_units
          FROM "OrderLineItem" li
          JOIN "SalesOrder" so ON so.id = li."salesOrderId"
          LEFT JOIN "Product" p ON p.id = li."productId"
          LEFT JOIN "Vendor" v ON v.id = p."vendorId"
          WHERE so."orderDate" >= ${startDate}::date
            AND so."orderDate" < (${endDate}::date + INTERVAL '1 day')
            AND li."lineItemStatus" <> 'CANCELLED'
          GROUP BY 1
        `
      : await prisma.$queryRaw<ReturnsRawGroupRow[]>`
          SELECT COALESCE(d.name, 'Uncategorized') AS key,
                 SUM(li."netPrice") FILTER (WHERE so.status IN ('ORDER', 'FULFILLED'))::float8 AS gross,
                 SUM(li."netPrice") FILTER (WHERE so.status = 'RETURNED')::float8 AS returns_net,
                 SUM(li."orderedQuantity") FILTER (WHERE so.status = 'RETURNED')::float8 AS returned_units
          FROM "OrderLineItem" li
          JOIN "SalesOrder" so ON so.id = li."salesOrderId"
          LEFT JOIN "Product" p ON p.id = li."productId"
          LEFT JOIN "Department" d ON d.id = p."departmentId"
          WHERE so."orderDate" >= ${startDate}::date
            AND so."orderDate" < (${endDate}::date + INTERVAL '1 day')
            AND li."lineItemStatus" <> 'CANCELLED'
          GROUP BY 1
        `;

  const productRows = await prisma.$queryRaw<ReturnsRawProductRow[]>`
    SELECT p."productNumber" AS product_number,
           p.name AS name,
           SUM(li."netPrice")::float8 AS returns_net,
           SUM(li."orderedQuantity")::float8 AS returned_units
    FROM "OrderLineItem" li
    JOIN "SalesOrder" so ON so.id = li."salesOrderId"
    JOIN "Product" p ON p.id = li."productId"
    WHERE so."orderDate" >= ${startDate}::date
      AND so."orderDate" < (${endDate}::date + INTERVAL '1 day')
      AND li."lineItemStatus" <> 'CANCELLED'
      AND so.status = 'RETURNED'
    GROUP BY p.id, p."productNumber", p.name
    HAVING SUM(li."netPrice") < 0
    ORDER BY SUM(li."netPrice") ASC
    LIMIT 25
  `;

  return summarizeReturns(groupRows, productRows, { pivot, startDate, endDate });
}

/**
 * Shape raw GROUP BY rows into the returns result: take the magnitude of the
 * negative return credits, derive return rate, drop empty groups, sort by returns,
 * and total. Pure — no I/O — so the math is unit-tested without a database.
 */
export function summarizeReturns(
  groupRows: ReturnsRawGroupRow[],
  productRows: ReturnsRawProductRow[],
  meta: { pivot: ReturnsPivot; startDate: string; endDate: string },
): ReturnsResult {
  const rows: ReturnsRow[] = groupRows
    .map((r) => {
      const grossSales = round2(Number(r.gross) || 0);
      const returns = round2(Math.abs(Number(r.returns_net) || 0));
      return {
        key: r.key ?? "Uncategorized",
        grossSales,
        returns,
        returnRate: rate(returns, grossSales),
        returnedUnits: Math.abs(Math.round(Number(r.returned_units) || 0)),
      };
    })
    .filter((r) => r.grossSales > 0 || r.returns > 0)
    .sort((a, b) => b.returns - a.returns);

  const totalGross = round2(rows.reduce((s, r) => s + r.grossSales, 0));
  const totalReturns = round2(rows.reduce((s, r) => s + r.returns, 0));
  const totalReturnedUnits = rows.reduce((s, r) => s + r.returnedUnits, 0);

  const topReturnedProducts: ReturnedProduct[] = productRows.map((r) => ({
    productNumber: r.product_number,
    name: r.name ?? "(unnamed)",
    returns: round2(Math.abs(Number(r.returns_net) || 0)),
    returnedUnits: Math.abs(Math.round(Number(r.returned_units) || 0)),
  }));

  return {
    pivot: meta.pivot,
    startDate: meta.startDate,
    endDate: meta.endDate,
    totals: {
      grossSales: totalGross,
      returns: totalReturns,
      returnRate: rate(totalReturns, totalGross),
      returnedUnits: totalReturnedUnits,
    },
    rows,
    topReturnedProducts,
  };
}
