// /app/src/lib/reports/dormantCustomers.ts
//
// Dormant customer winback report: high-value customers who haven't been back
// within a configurable window, with their top department by spend. Extracted
// from the Pages API so the App Router page + tRPC procedure share one source of
// truth. CLAUDE.md rule 33: cancelled lines excluded. netPrice is the LINE
// TOTAL, not unit price.

import type { PrismaClient } from "@prisma/client";

export interface DormantRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  totalSpend: number;
  orderCount: number;
  lastOrderDate: string | null;
  daysSinceLast: number;
  topDepartment: string | null;
  deptCount: number;
  customerGroup: string | null;
  customerLevel: number | null;
  peakCustomerLevel: number | null;
}

export interface DormantCustomersResult {
  rows: DormantRow[];
  totals: {
    total: number;
    vipCount: number;
    highValueCount: number;
    totalPastSpend: number;
    avgDays: number;
  };
}

export interface DormantCustomersParams {
  minSpend?: number;
  minMonths?: number;
  maxMonths?: number;
}

interface RawRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  totalSpend: number;
  orderCount: bigint;
  lastOrderDate: Date | null;
  daysSinceLast: number;
  topDepartment: string | null;
  deptCount: number;
  customerGroup: string | null;
  customerLevel: number | null;
  peakCustomerLevel: number | null;
}

export async function getDormantCustomers(
  prisma: PrismaClient,
  params: DormantCustomersParams = {},
): Promise<DormantCustomersResult> {
  const minSpend = params.minSpend ?? 2000;
  const minMonths = params.minMonths ?? 6;
  const maxMonths = params.maxMonths ?? 36;

  const rows = await prisma.$queryRawUnsafe<RawRow[]>(
    `
    WITH customer_top_dept AS (
      SELECT
        so."customerId",
        d.name AS dept,
        SUM(li."netPrice"::float) AS dept_spend,
        ROW_NUMBER() OVER (PARTITION BY so."customerId" ORDER BY SUM(li."netPrice"::float) DESC) AS rn
      FROM "SalesOrder" so
      JOIN "OrderLineItem" li ON li."salesOrderId" = so.id
      LEFT JOIN "Product" p ON p.id = li."productId"
      LEFT JOIN "Category" cat ON cat.id = p."categoryId"
      LEFT JOIN "Department" d ON d.id = cat."departmentId"
      WHERE so."customerId" IS NOT NULL
        AND so.status IN ('ORDER', 'FULFILLED')
        AND li."lineItemStatus" != 'CANCELLED'
        AND d.name NOT IN ('Freight', 'MRC', 'Hardware')
      GROUP BY so."customerId", d.name
    )
    SELECT
      c.id,
      c."firstName",
      c."lastName",
      c.email,
      c.phone,
      COALESCE(c."lifetimeSpend"::float, 0) AS "totalSpend",
      COALESCE(c."lifetimeOrderCount", 0)::bigint AS "orderCount",
      c."lastOrderDate",
      COALESCE(EXTRACT(DAY FROM NOW() - c."lastOrderDate")::int, 0) AS "daysSinceLast",
      ctd.dept AS "topDepartment",
      COALESCE(c."departmentCount", 0) AS "deptCount",
      c."customerGroup",
      c."customerLevel",
      c."peakCustomerLevel"
    FROM "Customer" c
    LEFT JOIN customer_top_dept ctd ON ctd."customerId" = c.id AND ctd.rn = 1
    WHERE c."lifetimeSpend" >= $1
      AND c."lastOrderDate" < NOW() - ($2 || ' months')::interval
      AND c."lastOrderDate" > NOW() - ($3 || ' months')::interval
    ORDER BY c."lifetimeSpend" DESC
    `,
    minSpend,
    String(minMonths),
    String(maxMonths),
  );

  const results: DormantRow[] = rows.map((r) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    totalSpend: Math.round(r.totalSpend),
    orderCount: Number(r.orderCount),
    lastOrderDate: r.lastOrderDate ? r.lastOrderDate.toISOString().slice(0, 10) : null,
    daysSinceLast: r.daysSinceLast,
    topDepartment: r.topDepartment,
    deptCount: r.deptCount,
    customerGroup: r.customerGroup,
    customerLevel: r.customerLevel,
    peakCustomerLevel: r.peakCustomerLevel,
  }));

  const vipCount = results.filter((r) => r.totalSpend >= 10000).length;
  const highValueCount = results.filter((r) => r.totalSpend >= 5000 && r.totalSpend < 10000).length;
  const totalPastSpend = results.reduce((s, r) => s + r.totalSpend, 0);
  const avgDays =
    results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.daysSinceLast, 0) / results.length)
      : 0;

  return {
    rows: results,
    totals: { total: results.length, vipCount, highValueCount, totalPastSpend, avgDays },
  };
}
