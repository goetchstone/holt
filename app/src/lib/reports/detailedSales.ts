// /app/src/lib/reports/detailedSales.ts
//
// Detailed Sales (sales-by-department) report: a store/department/category/
// vendor breakdown summary plus a line-item drilldown for a single cell.
// Extracted verbatim from the Pages API (detailed-sales.ts + detailed-sales/
// items.ts) so the App Router page + tRPC procedures share one source of truth;
// the CSV export keeps its own REST route (detailed-sales/export.ts) and calls
// these functions directly during the migration.
//
// The two functions MUST keep an identical line-item filter shape — both carry
// the literal `lineItemStatus: { not: "CANCELLED" }` (CLAUDE.md rule 33). They
// live in one file so the summary and drilldown can never diverge: a past $405
// Main Store discrepancy (2026-04-25) came from the two REST handlers drifting
// apart. Revenue statuses include RETURNED so negative return lines net out
// rewrite chains. The POS exports netPrice as the line total (not per-unit), so
// it is never multiplied by orderedQuantity — that would double-count.

import type { PrismaClient } from "@prisma/client";
// `Prisma` is imported as a VALUE (not type-only): the Uncategorized drilldown
// branch uses `Prisma.sql` / `Prisma.empty` to build a parameterized raw query.
import { Prisma } from "@prisma/client";

// ----------------------------------------------------------------------------
// Summary (formerly detailed-sales.ts)
// ----------------------------------------------------------------------------

export interface DetailedSalesParams {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  departments?: string[]; // department names
  stores?: string[]; // store location names
  vendors?: string[]; // vendor names
}

export interface DetailedSalesRow {
  storeLocation: string;
  department: string;
  category: string;
  vendor: string;
  netSales: number;
  taxCollected: number;
  itemCount: number;
}

/**
 * One row per (store, department, category, vendor) bucket so the page can
 * pivot by either Department (default) or Vendor without a second fetch. Both
 * pivots use the same dataset; the page does the rollup in JS.
 *
 * Filters intersect via AND — the vendors filter applies to the same line-item
 * product join used for the department filter.
 */
export async function getDetailedSales(
  prisma: PrismaClient,
  params: DetailedSalesParams = {},
): Promise<DetailedSalesRow[]> {
  const departmentNames = params.departments ?? [];
  const storeNames = params.stores ?? [];
  const vendorNames = params.vendors ?? [];
  const startDate = params.startDate;
  const endDate = params.endDate;

  // Step 1: Find qualifying sales order IDs by date range + store filter.
  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
  };
  if (startDate && endDate) {
    orderWhere.orderDate = {
      gte: new Date(`${startDate}T00:00:00.000Z`),
      lte: new Date(`${endDate}T23:59:59.999Z`),
    };
  } else if (startDate) {
    orderWhere.orderDate = { gte: new Date(`${startDate}T00:00:00.000Z`) };
  } else if (endDate) {
    orderWhere.orderDate = { lte: new Date(`${endDate}T23:59:59.999Z`) };
  }
  if (storeNames.length > 0) {
    orderWhere.storeLocation = { in: storeNames };
  }

  const matchingOrders = await prisma.salesOrder.findMany({
    where: orderWhere,
    select: { id: true, storeLocation: true },
  });

  const orderIdSet = matchingOrders.map((o) => o.id);

  if (orderIdSet.length === 0) {
    return [];
  }

  // Step 2: Fetch line items for those order IDs.
  // CLAUDE.md rule 33: cancelled lines must never inflate report totals.
  // Department + vendor filters layer on the same product join.
  const liWhere: Prisma.OrderLineItemWhereInput = {
    salesOrderId: { in: orderIdSet },
    lineItemStatus: { not: "CANCELLED" },
  };
  if (departmentNames.length > 0 || vendorNames.length > 0) {
    const productFilter: Prisma.ProductWhereInput = {};
    if (departmentNames.length > 0) {
      productFilter.department = { name: { in: departmentNames } };
    }
    if (vendorNames.length > 0) {
      productFilter.vendor = { name: { in: vendorNames } };
    }
    liWhere.product = productFilter;
  }

  const lineItems = await prisma.orderLineItem.findMany({
    where: liWhere,
    select: {
      netPrice: true,
      orderedQuantity: true,
      vatAmount: true,
      salesOrderId: true,
      product: {
        select: {
          department: { select: { name: true } },
          category: { select: { name: true } },
          vendor: { select: { name: true } },
        },
      },
    },
  });

  // Build a map of orderId -> storeLocation for grouping
  const orderStoreMap = new Map<number, string>();
  for (const o of matchingOrders) {
    orderStoreMap.set(o.id, o.storeLocation || "Unknown");
  }

  // Step 3: Group by store, department, category, vendor.
  const grouped: Record<string, DetailedSalesRow> = {};

  for (const li of lineItems) {
    const store = orderStoreMap.get(li.salesOrderId) || "Unknown";
    const dept = li.product?.department?.name || "Uncategorized";
    const cat = li.product?.category?.name || "";
    const vendor = li.product?.vendor?.name || "Unknown Vendor";
    const key = `${store}|${dept}|${cat}|${vendor}`;

    // the POS exports netPrice as the line total (not per-unit), so do not
    // multiply by orderedQuantity -- that would double-count.
    const lineNet = Number(li.netPrice || 0);
    const lineTax = Number(li.vatAmount || 0);

    if (grouped[key]) {
      grouped[key].netSales += lineNet;
      grouped[key].taxCollected += lineTax;
      if (lineNet > 0) grouped[key].itemCount += 1;
    } else {
      grouped[key] = {
        storeLocation: store,
        department: dept,
        category: cat,
        vendor,
        netSales: lineNet,
        taxCollected: lineTax,
        itemCount: lineNet > 0 ? 1 : 0,
      };
    }
  }

  return Object.values(grouped)
    .map((row) => ({
      ...row,
      netSales: Math.round(row.netSales * 100) / 100,
      taxCollected: Math.round(row.taxCollected * 100) / 100,
    }))
    .sort((a, b) => a.storeLocation.localeCompare(b.storeLocation) || b.netSales - a.netSales);
}

// ----------------------------------------------------------------------------
// Drilldown (formerly detailed-sales/items.ts)
// ----------------------------------------------------------------------------

export interface DetailedSalesItemsParams {
  store?: string | null;
  department?: string | null;
  category?: string | null;
  vendor?: string | null;
  type?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface DetailedSalesItem {
  id: number;
  orderId: number;
  orderno: string;
  orderDate: string | null;
  customerName: string | null;
  storeLocation: string | null;
  partNo: string | null;
  barcode: string | null;
  productName: string | null;
  netPrice: number;
  vatAmount: number;
  orderedQuantity: number;
  lineItemStatus: string | null;
  productId: number | null;
  productNumber: string | null;
  departmentName: string | null;
  categoryName: string | null;
  typeName: string | null;
  vendorName: string | null;
}

const UNCATEGORIZED = "Uncategorized";

const lineItemSelect = {
  id: true,
  partNo: true,
  barcode: true,
  productName: true,
  netPrice: true,
  vatAmount: true,
  orderedQuantity: true,
  lineItemStatus: true,
  productId: true,
  salesOrder: {
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      storeLocation: true,
      customer: { select: { firstName: true, lastName: true } },
    },
  },
  product: {
    select: {
      productNumber: true,
      department: { select: { name: true } },
      category: { select: { name: true } },
      type: { select: { name: true } },
      vendor: { select: { name: true } },
    },
  },
} satisfies Prisma.OrderLineItemSelect;

type DrilldownLineItem = Prisma.OrderLineItemGetPayload<{ select: typeof lineItemSelect }>;

/**
 * Line items that make up a single summary cell (store + department, and
 * optional category / vendor / type / date range). Used by the report's
 * inline expansion so managers can see exactly what's bucketed as
 * "Uncategorized" and fix it via the edit flow.
 */
export async function getDetailedSalesItems(
  prisma: PrismaClient,
  params: DetailedSalesItemsParams = {},
): Promise<DetailedSalesItem[]> {
  const store = params.store ?? null;
  const department = params.department ?? null;
  const category = params.category ?? null;
  const vendor = params.vendor ?? null;
  const type = params.type ?? null;
  const startDate = params.startDate ?? null;
  const endDate = params.endDate ?? null;

  const orderWhere: Prisma.SalesOrderWhereInput = {
    status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
  };
  if (store) orderWhere.storeLocation = store;
  if (startDate) {
    orderWhere.orderDate = { gte: new Date(`${startDate}T00:00:00.000Z`) };
  }
  if (endDate) {
    orderWhere.orderDate = {
      ...(orderWhere.orderDate as object),
      lte: new Date(`${endDate}T23:59:59.999Z`),
    };
  }

  const liWhere: Prisma.OrderLineItemWhereInput = {
    salesOrder: orderWhere,
    lineItemStatus: { not: "CANCELLED" },
  };

  if (department === UNCATEGORIZED) {
    // "Uncategorized" = NULL productId OR product with no department.
    // Prisma 7 types disallow nullable-Int equality in a relation filter,
    // so union two queries in JS below.
    // Vendor / type / category filters are skipped in this branch — by
    // definition Uncategorized rows have no department-aware metadata
    // to narrow on.
  } else {
    // Build a single Product where filter combining all the optional
    // narrowings the page can layer on (department, category, vendor,
    // type). Each is a separate clickable drill level; together they
    // intersect via AND.
    const productFilter: Prisma.ProductWhereInput = {};
    if (department) productFilter.department = { name: department };
    if (category) productFilter.category = { name: category };
    if (vendor) productFilter.vendor = { name: vendor };
    if (type) productFilter.type = { name: type };
    if (Object.keys(productFilter).length > 0) {
      liWhere.product = productFilter;
    }
  }

  let items: DrilldownLineItem[];

  if (department === UNCATEGORIZED) {
    // NULL productId — use plain relation where
    const nullProductItems = await prisma.orderLineItem.findMany({
      where: { ...liWhere, productId: null },
      orderBy: [{ salesOrder: { orderDate: "desc" } }, { id: "asc" }],
      take: 500,
      select: lineItemSelect,
    });
    // Product exists but has no department — filter in JS after fetching a
    // superset (line items with a product that is not null). To keep this
    // cheap, restrict to line items whose product's departmentId is checked
    // via a raw query of the id set, then load them.
    const orphanIds: { id: number }[] = await prisma.$queryRaw`
        SELECT li.id
        FROM "OrderLineItem" li
        JOIN "SalesOrder" so ON so.id = li."salesOrderId"
        JOIN "Product" p ON p.id = li."productId"
        WHERE so.status IN ('ORDER', 'FULFILLED', 'RETURNED')
          AND (li."lineItemStatus" IS NULL OR li."lineItemStatus" <> 'CANCELLED')
          AND p."departmentId" IS NULL
          ${store ? Prisma.sql`AND so."storeLocation" = ${store}` : Prisma.empty}
          ${startDate ? Prisma.sql`AND so."orderDate" >= ${new Date(`${startDate}T00:00:00.000Z`)}` : Prisma.empty}
          ${endDate ? Prisma.sql`AND so."orderDate" <= ${new Date(`${endDate}T23:59:59.999Z`)}` : Prisma.empty}
        ORDER BY so."orderDate" DESC, li.id ASC
        LIMIT 500
      `;
    const orphanItems =
      orphanIds.length > 0
        ? await prisma.orderLineItem.findMany({
            where: { id: { in: orphanIds.map((r) => r.id) } },
            select: lineItemSelect,
          })
        : [];
    items = [...nullProductItems, ...orphanItems].slice(0, 500);
  } else {
    items = await prisma.orderLineItem.findMany({
      where: liWhere,
      orderBy: [{ salesOrder: { orderDate: "desc" } }, { id: "asc" }],
      take: 500,
      select: lineItemSelect,
    });
  }

  return items.map((li) => ({
    id: li.id,
    orderId: li.salesOrder.id,
    orderno: li.salesOrder.orderno,
    orderDate: li.salesOrder.orderDate ? li.salesOrder.orderDate.toISOString() : null,
    customerName: li.salesOrder.customer
      ? [li.salesOrder.customer.firstName, li.salesOrder.customer.lastName]
          .filter(Boolean)
          .join(" ") || null
      : null,
    storeLocation: li.salesOrder.storeLocation,
    partNo: li.partNo,
    barcode: li.barcode,
    productName: li.productName,
    netPrice: Number(li.netPrice),
    vatAmount: Number(li.vatAmount ?? 0),
    orderedQuantity: Number(li.orderedQuantity),
    lineItemStatus: li.lineItemStatus ?? null,
    productId: li.productId,
    productNumber: li.product?.productNumber ?? null,
    departmentName: li.product?.department?.name ?? null,
    categoryName: li.product?.category?.name ?? null,
    typeName: li.product?.type?.name ?? null,
    vendorName: li.product?.vendor?.name ?? null,
  }));
}
