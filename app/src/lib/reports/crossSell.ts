// /app/src/lib/reports/crossSell.ts
//
// Cross-sell opportunity report: furniture buyers who haven't purchased from
// high-value complementary departments. Extracted from the Pages API so the App
// Router page + tRPC procedure share one source of truth. CLAUDE.md rule 33:
// cancelled lines excluded. netPrice is the LINE TOTAL, not unit price.

import type { PrismaClient } from "@prisma/client";

export interface CrossSellRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  furnitureSpend: number;
  lastFurnitureOrder: string | null;
  departmentsBought: string[];
  departmentsNotBought: string[];
}

export interface CrossSellResult {
  rows: CrossSellRow[];
  totals: {
    total: number;
    totalFurnCustomers: number;
    neverRugs: number;
    neverCurtains: number;
    deptCounts: Record<string, number>;
  };
}

export interface CrossSellParams {
  target?: string | null;
  minSpend?: number;
}

const TARGET_DEPTS = [
  "Rugs",
  "Curtains",
  "Outdoor Furniture",
  "Lamps",
  "Bedding",
  "Womens Apparel",
  "Mens Apparel",
  "Home Acc",
];

interface RawRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  furnitureSpend: number;
  lastFurnitureOrder: Date | null;
  departments: string;
}

export async function getCrossSell(
  prisma: PrismaClient,
  params: CrossSellParams = {},
): Promise<CrossSellResult> {
  const target = params.target ?? null;
  const minSpend = params.minSpend ?? 1000;

  const customers = await prisma.$queryRaw<RawRow[]>`
    WITH customer_depts AS (
      SELECT
        c.id,
        c."firstName",
        c."lastName",
        c.email,
        c.phone,
        d.name AS dept,
        SUM(CASE WHEN d.name = 'Furniture' THEN li."netPrice"::float ELSE 0 END) AS furn_spend,
        MAX(CASE WHEN d.name = 'Furniture' THEN so."orderDate" ELSE NULL END) AS last_furn
      FROM "Customer" c
      JOIN "SalesOrder" so ON so."customerId" = c.id
      JOIN "OrderLineItem" li ON li."salesOrderId" = so.id
      LEFT JOIN "Product" p ON p.id = li."productId"
      LEFT JOIN "Category" cat ON cat.id = p."categoryId"
      LEFT JOIN "Department" d ON d.id = cat."departmentId"
      WHERE so.status IN ('ORDER', 'FULFILLED')
        AND li."lineItemStatus" != 'CANCELLED'
      GROUP BY c.id, c."firstName", c."lastName", c.email, c.phone, d.name
    )
    SELECT
      id, "firstName", "lastName", email, phone,
      SUM(furn_spend)::float AS "furnitureSpend",
      MAX(last_furn) AS "lastFurnitureOrder",
      STRING_AGG(DISTINCT dept, ',' ORDER BY dept) AS departments
    FROM customer_depts
    WHERE id IN (
      SELECT id FROM customer_depts WHERE dept = 'Furniture' GROUP BY id HAVING SUM(furn_spend) >= ${minSpend}
    )
    GROUP BY id, "firstName", "lastName", email, phone
    HAVING SUM(furn_spend) >= ${minSpend}
    ORDER BY SUM(furn_spend) DESC
  `;

  const rows: CrossSellRow[] = [];
  const deptCounts: Record<string, number> = {};

  for (const c of customers) {
    const bought = (c.departments || "").split(",").filter(Boolean);
    const notBought = TARGET_DEPTS.filter((d) => !bought.includes(d));

    if (target && bought.includes(target)) continue;
    if (notBought.length === 0) continue;

    for (const d of notBought) {
      deptCounts[d] = (deptCounts[d] || 0) + 1;
    }

    rows.push({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      furnitureSpend: Math.round(c.furnitureSpend),
      lastFurnitureOrder: c.lastFurnitureOrder
        ? c.lastFurnitureOrder.toISOString().slice(0, 10)
        : null,
      departmentsBought: bought,
      departmentsNotBought: notBought,
    });
  }

  return {
    rows,
    totals: {
      total: rows.length,
      totalFurnCustomers: customers.length,
      neverRugs: deptCounts["Rugs"] || 0,
      neverCurtains: deptCounts["Curtains"] || 0,
      deptCounts,
    },
  };
}
