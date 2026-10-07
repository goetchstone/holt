// /app/src/lib/customerLeveling.ts
//
// Customer leveling logic with department-group-aware windows.
// Groups: FURNITURE (12mo), HOME_ACC (12mo), APPAREL (6mo), CHRISTMAS (seasonal).
// Levels 1-4 based on order frequency x value vs group averages.
// Peak level never decreases. Cross-shop bonus for 3+ groups.
//
// 2026-04-25: regrouped from {HOME/LIFESTYLE/APPAREL/CHRISTMAS} to
// {FURNITURE/HOME_ACC/APPAREL/CHRISTMAS}. The old "HOME" bucket mixed
// hard-goods (sofas, rugs) with decorative items (lamps, bedding) that
// buyers and customers think about differently. Migration
// 20260425_rename_customer_groups migrated unambiguous LIFESTYLE rows
// to HOME_ACC and nulled HOME rows pending a Recalculate Levels run.

import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger } from "@/lib/logger";

// --- Department Group Configuration ---

interface DeptGroupConfig {
  windowMonths: number;
  departments: string[];
}

const DEPT_GROUPS: Record<string, DeptGroupConfig> = {
  FURNITURE: {
    windowMonths: 12,
    departments: [
      "Furniture",
      "Outdoor Furniture",
      "Outdoor",
      "Rugs",
      "Curtains",
      "Window Treatments",
      "Bedroom",
      "Dining Room",
    ],
  },
  HOME_ACC: {
    windowMonths: 12,
    departments: [
      "Home Acc",
      "Tabletops",
      "Bedding",
      "Lamps",
      "Prints",
      "Print",
      "Mirrors",
      "Mirr",
      "Bath",
      "Floral",
      "Childrens",
      "Uncategorized",
    ],
  },
  APPAREL: {
    windowMonths: 6,
    departments: ["Womens Apparel", "Mens Apparel", "Apparel", "Accessories"],
  },
  CHRISTMAS: {
    windowMonths: 0, // seasonal — computed separately
    departments: ["Christmas"],
  },
};

const EXCLUDED_DEPTS = [
  "Freight",
  "MRC",
  "Hardware",
  "TEAK-Cleaner",
  "Teak Protector",
  "Teak Shield",
];
const DEFAULT_GROUP = "HOME_ACC";

// Build reverse lookup: department name -> group name
const DEPT_TO_GROUP = new Map<string, string>();
for (const [group, config] of Object.entries(DEPT_GROUPS)) {
  for (const dept of config.departments) {
    DEPT_TO_GROUP.set(dept, group);
  }
}

export function getDeptGroup(deptName: string | null): string | null {
  if (!deptName) return DEFAULT_GROUP;
  if (EXCLUDED_DEPTS.includes(deptName)) return null;
  return DEPT_TO_GROUP.get(deptName) ?? DEFAULT_GROUP;
}

/** Get the rolling window cutoff date for a department group. */
function getWindowCutoff(group: string): Date {
  const now = new Date();
  if (group === "CHRISTMAS") {
    // Seasonal: Sept 1 of current year, or prior year if before September
    const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    return new Date(year, 8, 1); // Sept 1
  }
  const config = DEPT_GROUPS[group];
  if (!config) return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - config.windowMonths);
  return cutoff;
}

// --- Recalculation ---

interface GroupStats {
  group: string;
  count: number;
  avgFreq: number;
  avgValue: number;
  windowMonths: number;
}

export interface RecalculationResult {
  customersUpdated: number;
  groupStats: Record<string, GroupStats>;
}

/**
 * Full customer level recalculation. Updates:
 * - lifetimeSpend, lifetimeOrderCount, firstOrderDate, lastOrderDate
 * - departmentCount, customerGroup
 * - customerLevel (1-4 or null)
 * - peakCustomerLevel (only increases, never decreases)
 *
 * Sales-status filter: ORDER + FULFILLED + RETURNED. Including
 * RETURNED is mandatory — its negative netPrice rows are what net
 * out the rewrite chain (base + return + rewrite). Excluding it
 * double-counts every rewritten sale and inflates lifetime spend.
 * See `lib/salesOrderRevenue.ts` for the full rationale and the
 * 2026-05-13 failure-log entry for the worked example.
 *
 * After deploying this change, run `POST /api/customers/recalculate-levels`
 * once to update `Customer.lifetimeSpend` for every customer with
 * any historical rewrites or returns.
 */
export async function recalculateCustomerLevels(): Promise<RecalculationResult> {
  return prisma.$transaction(async (tx) => {
    // Step 1: Update lifetime stats for all customers with orders
    await tx.$executeRaw`
      WITH customer_stats AS (
        SELECT
          so."customerId",
          COALESCE(SUM(li."netPrice"), 0) AS total_spend,
          COUNT(DISTINCT so.id) AS order_count,
          MIN(so."orderDate") AS first_order,
          MAX(so."orderDate") AS last_order
        FROM "SalesOrder" so
        JOIN "OrderLineItem" li ON li."salesOrderId" = so.id
        WHERE so."customerId" IS NOT NULL
          AND so.status IN ('ORDER', 'FULFILLED', 'RETURNED')
          AND li."lineItemStatus" != 'CANCELLED'
        GROUP BY so."customerId"
      )
      UPDATE "Customer" c
      SET
        "lifetimeSpend" = cs.total_spend,
        "lifetimeOrderCount" = cs.order_count,
        "firstOrderDate" = cs.first_order,
        "lastOrderDate" = cs.last_order
      FROM customer_stats cs
      WHERE c.id = cs."customerId"
    `;

    // Step 2: Determine primary group and department count per customer
    const excludedList = EXCLUDED_DEPTS.map((d) => `'${d}'`).join(",");
    const groupCaseWhen = Object.entries(DEPT_GROUPS)
      .map(([group, config]) => {
        const deptList = config.departments.map((d) => `'${d}'`).join(",");
        return `WHEN d.name IN (${deptList}) THEN '${group}'`;
      })
      .join("\n            ");

    // Raw query to get primary group (most spend) and group count per customer
    const customerGroups = await tx.$queryRawUnsafe<
      { customerId: number; primaryGroup: string; groupCount: number }[]
    >(`
      WITH line_groups AS (
        SELECT
          so."customerId",
          CASE
            ${groupCaseWhen}
            WHEN d.name IS NULL THEN '${DEFAULT_GROUP}'
            ELSE '${DEFAULT_GROUP}'
          END AS dept_group,
          SUM(li."netPrice") AS group_spend
        FROM "SalesOrder" so
        JOIN "OrderLineItem" li ON li."salesOrderId" = so.id
        LEFT JOIN "Product" p ON p.id = li."productId"
        LEFT JOIN "Category" cat ON cat.id = p."categoryId"
        LEFT JOIN "Department" d ON d.id = cat."departmentId"
        WHERE so."customerId" IS NOT NULL
          AND so.status IN ('ORDER', 'FULFILLED', 'RETURNED')
          AND li."lineItemStatus" != 'CANCELLED'
          AND COALESCE(d.name, '') NOT IN (${excludedList})
        GROUP BY so."customerId", dept_group
      ),
      ranked AS (
        SELECT
          "customerId",
          dept_group,
          group_spend,
          ROW_NUMBER() OVER (PARTITION BY "customerId" ORDER BY group_spend DESC) AS rn
        FROM line_groups
        WHERE dept_group IS NOT NULL
      )
      SELECT
        r."customerId" AS "customerId",
        r.dept_group AS "primaryGroup",
        (SELECT COUNT(DISTINCT dept_group) FROM line_groups lg WHERE lg."customerId" = r."customerId" AND dept_group IS NOT NULL)::int AS "groupCount"
      FROM ranked r
      WHERE r.rn = 1
    `);

    // Update customerGroup and departmentCount
    const groupMap = new Map<number, { group: string; count: number }>();
    for (const row of customerGroups) {
      groupMap.set(row.customerId, { group: row.primaryGroup, count: row.groupCount });
    }

    // Batch update customerGroup and departmentCount
    for (const group of Object.keys(DEPT_GROUPS)) {
      const ids = customerGroups.filter((r) => r.primaryGroup === group).map((r) => r.customerId);
      if (ids.length > 0) {
        await tx.customer.updateMany({
          where: { id: { in: ids } },
          data: { customerGroup: group },
        });
      }
    }

    for (const deptCount of [1, 2, 3, 4]) {
      const ids = customerGroups.filter((r) => r.groupCount === deptCount).map((r) => r.customerId);
      if (ids.length > 0) {
        await tx.customer.updateMany({
          where: { id: { in: ids } },
          data: { departmentCount: deptCount },
        });
      }
    }

    // Step 3: Compute levels within each group's rolling window
    const allUpdates: { id: number; level: number }[] = [];
    const groupStatsResult: Record<string, GroupStats> = {};

    for (const [group, config] of Object.entries(DEPT_GROUPS)) {
      const cutoff = getWindowCutoff(group);
      const deptList = config.departments.map((d) => `'${d}'`).join(",");

      // Include NULL department for HOME group
      const nullClause = group === DEFAULT_GROUP ? `OR d.name IS NULL` : "";

      const stats = await tx.$queryRawUnsafe<
        { customerId: number; orderCount: bigint; orderTotal: number }[]
      >(`
        SELECT
          so."customerId" AS "customerId",
          COUNT(DISTINCT so.id)::bigint AS "orderCount",
          COALESCE(SUM(li."netPrice"::float), 0)::float AS "orderTotal"
        FROM "SalesOrder" so
        JOIN "OrderLineItem" li ON li."salesOrderId" = so.id
        LEFT JOIN "Product" p ON p.id = li."productId"
        LEFT JOIN "Category" cat ON cat.id = p."categoryId"
        LEFT JOIN "Department" d ON d.id = cat."departmentId"
        WHERE so."customerId" IS NOT NULL
          AND so."orderDate" >= '${cutoff.toISOString()}'
          AND so.status IN ('ORDER', 'FULFILLED', 'RETURNED')
          AND li."lineItemStatus" != 'CANCELLED'
          AND (d.name IN (${deptList}) ${nullClause})
        GROUP BY so."customerId"
      `);

      if (stats.length === 0) {
        groupStatsResult[group] = {
          group,
          count: 0,
          avgFreq: 0,
          avgValue: 0,
          windowMonths: config.windowMonths,
        };
        continue;
      }

      const parsed = stats.map((s) => ({
        customerId: s.customerId,
        orderCount: Number(s.orderCount),
        orderTotal: s.orderTotal,
      }));

      const avgFreq = parsed.reduce((s, c) => s + c.orderCount, 0) / parsed.length;
      const avgValue = parsed.reduce((s, c) => s + c.orderTotal, 0) / parsed.length;

      groupStatsResult[group] = {
        group,
        count: parsed.length,
        avgFreq: Math.round(avgFreq * 100) / 100,
        avgValue: Math.round(avgValue * 100) / 100,
        windowMonths: config.windowMonths,
      };

      for (const c of parsed) {
        const aboveFreq = c.orderCount >= avgFreq;
        const aboveValue = c.orderTotal >= avgValue;
        let level: number;
        if (aboveFreq && aboveValue) level = 4;
        else if (!aboveFreq && aboveValue) level = 3;
        else if (aboveFreq && !aboveValue) level = 2;
        else level = 1;

        // Cross-shop bonus: 3+ groups gets +1 (capped at 4)
        const custGroups = groupMap.get(c.customerId);
        if (custGroups && custGroups.count >= 3 && level < 4) {
          level++;
        }

        allUpdates.push({ id: c.customerId, level });
      }
    }

    // Step 4: Apply levels
    // Reset customers not in any group's window to null
    const updatedIds = allUpdates.map((u) => u.id);
    await tx.customer.updateMany({
      where: {
        id: { notIn: updatedIds },
        customerLevel: { not: null },
      },
      data: { customerLevel: null },
    });

    for (const level of [1, 2, 3, 4]) {
      const ids = allUpdates.filter((u) => u.level === level).map((u) => u.id);
      if (ids.length > 0) {
        await tx.customer.updateMany({
          where: { id: { in: ids } },
          data: { customerLevel: level },
        });
      }
    }

    // Step 5: Update peakCustomerLevel (only increases)
    await tx.$executeRaw`
      UPDATE "Customer"
      SET "peakCustomerLevel" = "customerLevel"
      WHERE "customerLevel" IS NOT NULL
        AND ("peakCustomerLevel" IS NULL OR "customerLevel" > "peakCustomerLevel")
    `;

    const customersUpdated = allUpdates.length;
    logger.info("Customer levels recalculated", {
      customersUpdated,
      groups: Object.keys(groupStatsResult).length,
    });

    return { customersUpdated, groupStats: groupStatsResult };
  }, TX_TIMEOUT.LONG);
}
