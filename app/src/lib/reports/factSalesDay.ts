// /app/src/lib/reports/factSalesDay.ts
//
// Daily sales summary aggregated from SalesOrder + OrderLineItem, grouped by
// date and department (total sales, transaction count, average sale).
// Extracted from the Pages API handler so the App Router server component and
// the tRPC procedure share one source of truth. CLAUDE.md rule 33: cancelled
// lines are excluded so they never inflate totals.
//
// Aggregation runs in the DB (GROUP BY), NOT by loading rows into JS. The prior
// `findMany` pulled every order + line item + product; Prisma's relation IN-lists
// then exceeded Postgres's 65535 bind-parameter limit on real-scale data (P2029).
// A GROUP BY has no such limit and is far cheaper.

import type { PrismaClient } from "@prisma/client";

export interface FactSalesDayRow {
  date: string;
  department: string;
  totalSales: number;
  numTransactions: number;
  avgSale: number;
}

interface RawRow {
  date: string;
  department: string;
  total_sales: number;
  num_transactions: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getFactSalesDay(prisma: PrismaClient): Promise<FactSalesDayRow[]> {
  // orderDate is stored UTC (Prisma timestamp), so to_char gives the same Y-M-D
  // the prior `orderDate.toISOString().slice(0,10)` produced. No bind params /
  // user input -> $queryRawUnsafe with a constant string is safe.
  const rows = await prisma.$queryRawUnsafe<RawRow[]>(`
    SELECT to_char(so."orderDate", 'YYYY-MM-DD') AS date,
           COALESCE(d.name, 'Uncategorized') AS department,
           SUM(li."netPrice")::float8 AS total_sales,
           COUNT(*)::int AS num_transactions
    FROM "OrderLineItem" li
    JOIN "SalesOrder" so ON so.id = li."salesOrderId"
    LEFT JOIN "Product" p ON p.id = li."productId"
    LEFT JOIN "Department" d ON d.id = p."departmentId"
    WHERE so."orderDate" IS NOT NULL
      AND li."lineItemStatus" != 'CANCELLED'
    GROUP BY 1, 2
  `);

  return rows
    .map((r) => {
      const totalSales = round2(Number(r.total_sales) || 0);
      const numTransactions = Number(r.num_transactions) || 0;
      const avgSale = numTransactions > 0 ? round2(totalSales / numTransactions) : 0;
      return { date: r.date, department: r.department, totalSales, numTransactions, avgSale };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.department.localeCompare(b.department));
}
