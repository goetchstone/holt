// /app/src/lib/reports/crossSell.ts
//
// Cross-sell opportunity report: buyers in the ANCHOR department who have not
// purchased from the departments flagged as cross-sell targets. Extracted from
// the Pages API so the App Router page + tRPC procedure share one source of
// truth. CLAUDE.md rule 33: cancelled lines excluded. netPrice is the LINE
// TOTAL, not unit price.
//
// The anchor and the target list used to be literals here -- 'Furniture' in
// three places in the SQL, and an eight-name TARGET_DEPTS array. Both are now
// Department.crossSellAnchor / Department.crossSellTarget, so a deployment that
// sells something other than furniture gets a report rather than an empty one
// (CLAUDE.md rule 61).

import type { PrismaClient } from "@prisma/client";
import { loadReportTaxonomy } from "@/lib/reports/reportTaxonomy";

export interface CrossSellRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  anchorSpend: number;
  lastAnchorOrder: string | null;
  departmentsBought: string[];
  departmentsNotBought: string[];
}

export interface CrossSellResult {
  rows: CrossSellRow[];
  totals: {
    total: number;
    totalAnchorCustomers: number;
    /** How many qualifying customers have never bought each target department. */
    deptCounts: Record<string, number>;
  };
  /**
   * The configured anchor, so the UI can label its columns. Null means no
   * department is flagged `crossSellAnchor` -- the report cannot qualify
   * anyone, and says so instead of rendering a confident zero.
   */
  anchorDepartment: string | null;
}

export interface CrossSellParams {
  target?: string | null;
  minSpend?: number;
}

interface RawRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  anchorSpend: number;
  lastAnchorOrder: Date | null;
  departments: string;
}

export async function getCrossSell(
  prisma: PrismaClient,
  params: CrossSellParams = {},
): Promise<CrossSellResult> {
  const target = params.target ?? null;
  const minSpend = params.minSpend ?? 1000;

  const taxonomy = await loadReportTaxonomy(prisma);
  const anchor = taxonomy.crossSellAnchor;

  // No anchor department means nothing qualifies a customer. Returning an empty
  // report with the anchor null lets the UI say "not configured" rather than
  // showing a zero that reads like a finding.
  if (anchor === null) {
    return {
      rows: [],
      totals: { total: 0, totalAnchorCustomers: 0, deptCounts: {} },
      anchorDepartment: null,
    };
  }

  const customers = await prisma.$queryRaw<RawRow[]>`
    WITH customer_depts AS (
      SELECT
        c.id,
        c."firstName",
        c."lastName",
        c.email,
        c.phone,
        d.name AS dept,
        SUM(CASE WHEN d.name = ${anchor} THEN li."netPrice"::float ELSE 0 END) AS anchor_spend,
        MAX(CASE WHEN d.name = ${anchor} THEN so."orderDate" ELSE NULL END) AS last_anchor
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
      SUM(anchor_spend)::float AS "anchorSpend",
      MAX(last_anchor) AS "lastAnchorOrder",
      STRING_AGG(DISTINCT dept, ',' ORDER BY dept) AS departments
    FROM customer_depts
    WHERE id IN (
      SELECT id FROM customer_depts WHERE dept = ${anchor} GROUP BY id HAVING SUM(anchor_spend) >= ${minSpend}
    )
    GROUP BY id, "firstName", "lastName", email, phone
    HAVING SUM(anchor_spend) >= ${minSpend}
    ORDER BY SUM(anchor_spend) DESC
  `;

  const rows: CrossSellRow[] = [];
  const deptCounts: Record<string, number> = {};

  for (const c of customers) {
    const bought = (c.departments || "").split(",").filter(Boolean);
    const notBought = taxonomy.crossSellTargets.filter((d) => !bought.includes(d));

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
      anchorSpend: Math.round(c.anchorSpend),
      lastAnchorOrder: c.lastAnchorOrder ? c.lastAnchorOrder.toISOString().slice(0, 10) : null,
      departmentsBought: bought,
      departmentsNotBought: notBought,
    });
  }

  return {
    rows,
    totals: {
      total: rows.length,
      totalAnchorCustomers: customers.length,
      deptCounts,
    },
    anchorDepartment: anchor,
  };
}
