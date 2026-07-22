// /app/src/lib/reports/salesExplorerQuery.ts
//
// Sales Explorer: holt-native two-period, four-dimension (store/department/
// category/vendor) cell aggregation + a product-level drilldown. NOT a port
// of furniture-configurator's SQL — that file assumes a different schema and
// this codebase's reporting invariants (docs/domains/reporting.md) are strict
// enough that a naive transplant would violate them. Built from the same
// Prisma patterns as lib/reports/comparativeSales.ts (order -> line-item
// fetch, JS-side grouping) and lib/reports/detailedSales.ts (the exact
// store/department/category/vendor cell shape), which this file was modeled
// on directly.
//
// The three reporting.md invariants, applied here:
//
//   (a) Cancelled-line rule — every OrderLineItem fetch below carries the
//       literal `lineItemStatus: { not: "CANCELLED" }` (CLAUDE.md rule 33).
//       LineItemStatus is non-nullable in the current schema (backfilled
//       2026-05-05, see reporting.md), so this specific `not:` is NOT a
//       NULL-trap case — but see (b) for the ones that would be.
//   (b) Nullable-column NULL trap — this file adds no `not:`/`notIn:` filter
//       on any OTHER nullable column, so the trap doesn't come up here. Where
//       it WOULD matter (a category/vendor exclusion), we deliberately use
//       Prisma's `in:` (a positive allow-list) instead, which has no NULL-
//       trap failure mode. Store/category/vendor names use `{ name: X }`
//       equality or `{ in: [...] }`, never a `not`.
//   (c) netPrice = line total — every sum below is `SUM(netPrice)` directly;
//       the line total is never multiplied by the ordered-quantity field.
//
// Revenue statuses use the canonical SALES_REVENUE_STATUSES constant (not a
// hand-rolled ["ORDER","FULFILLED"] list) so RETURNED orders' negative lines
// net out rewrite chains — see lib/salesOrderRevenue.ts.

import type { Prisma, PrismaClient } from "@prisma/client";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";
import { imputeMissingCost } from "@/lib/marginMath";
import {
  UNCATEGORIZED_DEPARTMENT,
  NO_CATEGORY_LABEL,
  UNKNOWN_VENDOR_LABEL,
  type SalesExplorerCellMap,
} from "./salesExplorerPivot";
import { getDetailedSalesItems, type DetailedSalesItem } from "./detailedSales";

export interface SalesExplorerDateRange {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
}

export interface SalesExplorerFilters {
  stores?: string[];
  departments?: string[];
  categories?: string[];
  vendors?: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Order-level WHERE shared by every Sales Explorer query: revenue statuses
 * (RETURNED included so return/rewrite negatives net out — invariant (a)'s
 * sister rule) + the date window + an optional store filter. Pure (no I/O) so
 * its exact shape is unit-tested without a database.
 */
export function buildSalesExplorerOrderWhere(
  dateRange: SalesExplorerDateRange,
  storeNames: string[],
): Prisma.SalesOrderWhereInput {
  const where: Prisma.SalesOrderWhereInput = {
    status: { in: [...SALES_REVENUE_STATUSES] },
  };
  const { startDate, endDate } = dateRange;
  if (startDate && endDate) {
    where.orderDate = {
      gte: new Date(`${startDate}T00:00:00.000Z`),
      lte: new Date(`${endDate}T23:59:59.999Z`),
    };
  } else if (startDate) {
    where.orderDate = { gte: new Date(`${startDate}T00:00:00.000Z`) };
  } else if (endDate) {
    where.orderDate = { lte: new Date(`${endDate}T23:59:59.999Z`) };
  }
  // Positive allow-list (`in:`), never a `not`/`notIn` — no NULL-trap
  // exposure even though storeLocation is nullable (invariant (b)).
  if (storeNames.length > 0) {
    where.storeLocation = { in: storeNames };
  }
  return where;
}

/**
 * Product-relation filter for the department / category / vendor
 * multi-selects, or undefined when none are active (so unmatched-product
 * lines are NOT dropped — a dept/cat/vendor filter naturally excludes
 * NULL-product lines, which is correct: you can't filter "Furniture" and
 * also expect to see a line with no product attached).
 *
 * Every branch here is a positive `in:` allow-list — never `not`/`notIn` — so
 * there is no nullable-column NULL trap (invariant (b)) even though
 * Product's department/category/vendor relations themselves are NOT
 * nullable (schema.prisma: departmentId/categoryId/vendorId are all
 * required Int columns).
 */
export function buildSalesExplorerProductFilter(
  deptNames: string[],
  categoryNames: string[],
  vendorNames: string[],
): Prisma.ProductWhereInput | undefined {
  if (deptNames.length === 0 && categoryNames.length === 0 && vendorNames.length === 0) {
    return undefined;
  }
  const filter: Prisma.ProductWhereInput = {};
  if (deptNames.length > 0) filter.department = { name: { in: deptNames } };
  if (categoryNames.length > 0) filter.category = { name: { in: categoryNames } };
  if (vendorNames.length > 0) filter.vendor = { name: { in: vendorNames } };
  return filter;
}

/**
 * Three-step line-cost fallback, same cascade documented for Detailed Sales
 * in reporting.md and implemented privately in
 * lib/reports/salesBySalespersonReport.ts's `resolveLineCost`:
 *   1. OrderLineItem.cost if set and non-zero (already a LINE cost, never
 *      multiplied by quantity — invariant (c)'s sister rule for cost).
 *   2. product.baseCost x orderedQuantity if line cost is zero.
 *   3. retail/2 imputation, applied by imputeMissingCost() below (the same
 *      pure helper marginMath.ts / Sales by Salesperson / Detailed Sales use).
 */
function baseLineCost(li: {
  cost: Prisma.Decimal | number | null;
  orderedQuantity: Prisma.Decimal | number | null;
  product: { baseCost: Prisma.Decimal | number | null } | null;
}): number {
  const rawLineCost = Number(li.cost ?? 0);
  if (rawLineCost !== 0) return rawLineCost;
  const qty = Number(li.orderedQuantity ?? 1);
  const productBaseCost = Number(li.product?.baseCost ?? 0);
  if (productBaseCost > 0 && qty > 0) return productBaseCost * qty;
  return 0;
}

/**
 * One period's cell map: every ACTIVE line item on a revenue-status order in
 * range, bucketed by (store, department, category, vendor). Call this once
 * per period (period 1, period 2) — mirrors comparativeSales.ts's per-period
 * `sumByStore` and detailedSales.ts's `getDetailedSales`.
 */
export async function computeSalesExplorerCells(
  prisma: PrismaClient,
  dateRange: SalesExplorerDateRange,
  filters: SalesExplorerFilters = {},
): Promise<SalesExplorerCellMap> {
  const storeNames = filters.stores ?? [];
  const deptNames = filters.departments ?? [];
  const categoryNames = filters.categories ?? [];
  const vendorNames = filters.vendors ?? [];

  const orderWhere = buildSalesExplorerOrderWhere(dateRange, storeNames);
  const matchingOrders = await prisma.salesOrder.findMany({
    where: orderWhere,
    select: { id: true, storeLocation: true },
  });
  const orderIds = matchingOrders.map((o) => o.id);
  if (orderIds.length === 0) return {};

  // Invariant (a): cancelled lines must never inflate report totals.
  const liWhere: Prisma.OrderLineItemWhereInput = {
    salesOrderId: { in: orderIds },
    lineItemStatus: { not: "CANCELLED" },
  };
  const productFilter = buildSalesExplorerProductFilter(deptNames, categoryNames, vendorNames);
  if (productFilter) liWhere.product = productFilter;

  const lineItems = await prisma.orderLineItem.findMany({
    where: liWhere,
    select: {
      netPrice: true,
      orderedQuantity: true,
      cost: true,
      salesOrderId: true,
      product: {
        select: {
          baseCost: true,
          department: { select: { name: true } },
          category: { select: { name: true } },
          vendor: { select: { name: true } },
        },
      },
    },
  });

  const storeByOrder = new Map<number, string>();
  for (const o of matchingOrders) {
    storeByOrder.set(o.id, o.storeLocation || "Unknown");
  }

  const cells: SalesExplorerCellMap = {};
  for (const li of lineItems) {
    const store = storeByOrder.get(li.salesOrderId) || "Unknown";
    const dept = li.product?.department?.name || UNCATEGORIZED_DEPARTMENT;
    const cat = li.product?.category?.name || ""; // displayed as "(No Category)" by the pivot builder
    const vendor = li.product?.vendor?.name || UNKNOWN_VENDOR_LABEL;
    const key = `${store}|${dept}|${cat}|${vendor}`;

    // Invariant (c): netPrice is the LINE TOTAL — never multiplied by
    // orderedQuantity.
    const lineNet = Number(li.netPrice || 0);
    const rawCost = baseLineCost(li);
    const { cost: lineCost } = imputeMissingCost({ retail: lineNet, cost: rawCost });

    const existing = cells[key];
    if (existing) {
      existing.netSales += lineNet;
      existing.cost += lineCost;
      if (lineNet > 0) existing.itemCount += 1;
    } else {
      cells[key] = { netSales: lineNet, cost: lineCost, itemCount: lineNet > 0 ? 1 : 0 };
    }
  }

  for (const cell of Object.values(cells)) {
    cell.netSales = round2(cell.netSales);
    cell.cost = round2(cell.cost);
  }
  return cells;
}

/**
 * Distinct order counts per store for one period, honoring the same
 * department/category/vendor narrowing as computeSalesExplorerCells (an
 * order counts toward a store only if it has at least one qualifying line
 * item after filtering). Only consumed by the Store pivot's top-level nodes
 * and the Store Traffic panel — mirrors comparativeSales.ts's `sumByStore`
 * order-counting Set.
 */
export async function computeSalesExplorerStoreOrderCounts(
  prisma: PrismaClient,
  dateRange: SalesExplorerDateRange,
  filters: SalesExplorerFilters = {},
): Promise<Record<string, number>> {
  const storeNames = filters.stores ?? [];
  const orderWhere = buildSalesExplorerOrderWhere(dateRange, storeNames);
  const productFilter = buildSalesExplorerProductFilter(
    filters.departments ?? [],
    filters.categories ?? [],
    filters.vendors ?? [],
  );

  const orders = await prisma.salesOrder.findMany({
    where: orderWhere,
    select: {
      id: true,
      storeLocation: true,
      lineItems: {
        // Invariant (a): cancelled lines excluded from the qualifying check too.
        where: {
          lineItemStatus: { not: "CANCELLED" },
          ...(productFilter ? { product: productFilter } : {}),
        },
        select: { id: true },
      },
    },
  });

  const counts: Record<string, number> = {};
  for (const order of orders) {
    if (order.lineItems.length === 0) continue;
    const store = order.storeLocation || "Unknown";
    counts[store] = (counts[store] ?? 0) + 1;
  }
  return counts;
}

// ----------------------------------------------------------------------------
// Product-level drilldown
// ----------------------------------------------------------------------------

export type SalesExplorerItem = DetailedSalesItem;

export interface SalesExplorerItemsParams {
  store?: string | null;
  department?: string | null;
  category?: string | null;
  vendor?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Product-level line items for ONE Sales Explorer tree node in ONE period's
 * date range. Delegates to Detailed Sales' `getDetailedSalesItems`
 * (lib/reports/detailedSales.ts) rather than re-deriving the filter logic.
 *
 * Why delegate instead of writing a second WHERE clause here: this file's
 * own header comment on detailedSales.ts already documents the failure mode
 * of NOT doing this — "a past $405 Main Store discrepancy (2026-04-25) came
 * from the two REST handlers drifting apart" when the summary and drilldown
 * lived in separate files with separately-maintained filters. Since
 * Product.departmentId/categoryId/vendorId are all NON-nullable columns
 * (schema.prisma), the three orphan sentinels this file's cell aggregation
 * produces ("Uncategorized" / "(No Category)" / "Unknown Vendor") can only
 * ever occur TOGETHER, on a line item with NO product at all (`productId IS
 * NULL`) — the exact case getDetailedSalesItems already special-cases with a
 * tested NULL-safe lookup. So any of the three sentinels normalizes to that
 * one call; every other department/category/vendor value is a real name on a
 * real product and needs no NULL handling at all.
 */
export async function getSalesExplorerItems(
  prisma: PrismaClient,
  params: SalesExplorerItemsParams,
): Promise<SalesExplorerItem[]> {
  const { store, department, category, vendor, startDate, endDate } = params;

  const isOrphanLeaf =
    department === UNCATEGORIZED_DEPARTMENT ||
    category === NO_CATEGORY_LABEL ||
    vendor === UNKNOWN_VENDOR_LABEL;

  if (isOrphanLeaf) {
    return getDetailedSalesItems(prisma, {
      store,
      department: UNCATEGORIZED_DEPARTMENT,
      startDate,
      endDate,
    });
  }

  return getDetailedSalesItems(prisma, { store, department, category, vendor, startDate, endDate });
}
