// /app/src/lib/commissionSales.ts
//
// Shared sales-aggregation helpers for commission code. Both the
// live preview (`api/admin/reports/commission-tiers.ts`) and the
// lock-it-in payout flow (`api/admin/reports/commission-payouts/*`)
// need to sum a designer's net sales over a date range using the
// same matching rules (FK + aliases + the POS-string + split).
// Keeping the logic in one place avoids drift between the two
// surfaces.

import { prisma } from "@/lib/prisma";
import { buildLineItemWhere } from "@/lib/salesBySalesperson";
import { imputeMissingCost, resolveLineCost } from "@/lib/marginMath";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import type { CommissionSaleRow } from "@/lib/commissionRuleEngine";

/**
 * Sum a designer's net sales over `[fromDate, toDateExclusive)`.
 *
 * Matching rules — must mirror designer-dashboard + salesperson-
 * detail so the numbers all agree:
 *   - SalesOrder.salesPersonId = staffId (FK match), OR
 *   - SalesOrder.splitWithId = staffId (split-with FK), OR
 *   - SalesOrder.salesperson matches displayName or any alias
 *     (case-insensitive equals — the POS still imports the string).
 *
 * Status filter: ORDER / FULFILLED / RETURNED (the canonical revenue
 * set). Returns net out as negative line items on RETURNED orders.
 *
 * Line-item filter: `buildLineItemWhere([], false)` excludes cancelled
 * lines + freight/delivery pass-throughs. Same shape used everywhere.
 *
 * Split orders are counted at 0.5× per partner (matches the HR comp
 * report's convention). If a designer is BOTH the primary and the
 * split partner on the same order (impossible in current data but
 * possible in principle), they get 1×.
 */
export async function sumDesignerSales(
  staffId: number,
  matchNames: string[],
  fromDate: Date,
  toDateExclusive: Date,
): Promise<number> {
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: fromDate, lt: toDateExclusive },
      status: { in: [...SALES_REVENUE_STATUSES] },
      OR: [
        ...matchNames.map((name) => ({
          salesperson: { equals: name, mode: "insensitive" as const },
        })),
        { salesPersonId: staffId },
        { splitWithId: staffId },
      ],
    },
    select: {
      splitWithId: true,
      lineItems: {
        where: buildLineItemWhere([], false),
        select: { netPrice: true },
      },
    },
  });

  let total = 0;
  for (const o of orders) {
    const multiplier = o.splitWithId ? 0.5 : 1;
    for (const li of o.lineItems) {
      total += Number(li.netPrice) * multiplier;
    }
  }
  return total;
}

/**
 * Row-level equivalent of `sumDesignerSales`, feeding the Stage 1 rule
 * engine (lib/commissionRuleEngine.ts). Same matching rules (FK + aliases +
 * the POS-string OR, 0.5x split multiplier, the cancelled-line filter via
 * `buildLineItemWhere`) and the same SALES_REVENUE_STATUSES scope (rule
 * 47) — this function must never diverge from `sumDesignerSales`'s WHERE
 * clause, or the engine's REVENUE-basis total for a scope-all rule would
 * stop matching the designer-level `ytdSalesAtStart`/`ytdSalesAtEnd` columns
 * that `computeDesignerYtdSums` (lib/runCommissionPayouts.ts) still computes
 * independently via `sumDesignerSales` for backward-compatible display.
 *
 * Unlike `sumDesignerSales`, this does NOT pre-sum — it returns one
 * `CommissionSaleRow` per line item so the engine can bucket by rule scope
 * (department/category/vendor/store/productType) and pick basis
 * (REVENUE/MARGIN/UNITS) per rule. MARGIN uses the SAME shared cost-fallback
 * cascade (`resolveLineCost` + `imputeMissingCost`) the Sales Explorer and
 * gross-margin reporting already use — see lib/marginMath.ts.
 */
export async function loadDesignerSaleRows(
  staffId: number,
  matchNames: string[],
  fromDate: Date,
  toDateExclusive: Date,
): Promise<CommissionSaleRow[]> {
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: fromDate, lt: toDateExclusive },
      status: { in: [...SALES_REVENUE_STATUSES] },
      OR: [
        ...matchNames.map((name) => ({
          salesperson: { equals: name, mode: "insensitive" as const },
        })),
        { salesPersonId: staffId },
        { splitWithId: staffId },
      ],
    },
    select: {
      id: true,
      orderDate: true,
      splitWithId: true,
      storeLocationId: true,
      lineItems: {
        where: buildLineItemWhere([], false),
        select: {
          netPrice: true,
          cost: true,
          orderedQuantity: true,
          product: {
            select: {
              baseCost: true,
              departmentId: true,
              categoryId: true,
              vendorId: true,
              typeId: true,
            },
          },
        },
      },
    },
  });

  const rows: CommissionSaleRow[] = [];
  for (const o of orders) {
    const multiplier = o.splitWithId ? 0.5 : 1;
    // orderDate is nullable in the schema; buildSalesOrderWhere above
    // requires it in-range, so it's non-null on every returned row, but
    // guard defensively rather than assert.
    const occurredAt = o.orderDate ?? fromDate;
    for (const li of o.lineItems) {
      const revenue = Number(li.netPrice ?? 0) * multiplier;
      const rawCost = resolveLineCost(li);
      const { cost } = imputeMissingCost({ retail: Number(li.netPrice ?? 0), cost: rawCost });
      const margin = (Number(li.netPrice ?? 0) - cost) * multiplier;
      const units = Number(li.orderedQuantity ?? 0) * multiplier;
      rows.push({
        transactionId: o.id,
        occurredAt,
        revenue,
        margin,
        units,
        departmentId: li.product?.departmentId ?? null,
        categoryId: li.product?.categoryId ?? null,
        vendorId: li.product?.vendorId ?? null,
        storeLocationId: o.storeLocationId ?? null,
        productTypeId: li.product?.typeId ?? null,
      });
    }
  }
  return rows;
}
