// /app/src/lib/reports/buyersReport.ts
//
// Buyers Report data layer: the on-hand + on-order + sold-in-range merchant
// pivot (getBuyersSummary) and the per-product location breakdown
// (getBuyersPositions). Extracted verbatim from the Pages API
// (buyers/summary.ts + buyers/positions.ts) so the App Router page + tRPC
// procedures share one source of truth.
//
// The on-hand / customer-stock / on-order / stock-vs-special classification SQL
// is load-bearing and copied as-is — every WHERE clause, the
// `lineItemStatus != 'CANCELLED'` filter (rule 33), the customer-hold
// location heuristic (`sl.name ILIKE 'customer%'`), the Issue #168 same-SO
// gates, and the cost waterfall are preserved exactly. Do not change the
// classification, on-hand, weeks-of-supply, or sell-through math here.

import type { PrismaClient } from "@prisma/client";
import { buildBuyersRollup, type ProductFact, type BuyersPivot } from "@/lib/buyersRollup";
import { buildFrameDecisions, type FrameInput } from "@/lib/frameRollup";

export type { BuyersPivot } from "@/lib/buyersRollup";

interface OnHandRow {
  productId: number;
  floorQty: number;
  customerQty: number;
}
interface SoldRow {
  productId: number;
  soldQty: number;
  soldTotal: number;
  stockSoldQty: number;
  stockSoldTotal: number;
  specialSoldQty: number;
  specialSoldTotal: number;
  soldCost: number;
  costEstimated: boolean;
  lastSold: Date | null;
}

export interface BuyersSummaryParams {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  pivot?: BuyersPivot;
  storeId?: number | null;
  rollupFrames?: boolean;
}

export class BuyersSummaryInputError extends Error {}

export interface PositionRow {
  storeName: string | null;
  locationCode: string | null;
  locationName: string | null;
  floorQty: number;
  customerQty: number;
}

export interface PositionsResponse {
  productId: number;
  productNumber: string | null;
  productName: string | null;
  vendorName: string | null;
  totalFloor: number;
  totalCustomer: number;
  totalOnOrder: number;
  earliestEsd: string | null;
  positions: PositionRow[];
}

export class BuyersPositionsNotFound extends Error {}

function parseDate(v: string | undefined | null): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Raw row shapes returned by the four parallel queries below.
interface RawOnHandRow {
  productId: number;
  floor_qty: bigint;
  customer_loc_qty: bigint;
}
interface RawCustomerStockRow {
  productId: number;
  customer_qty: bigint;
}
interface RawOnOrderRow {
  productId: number | null;
  on_order: string;
}
interface RawSoldRow {
  productId: number | null;
  sold_qty: string;
  sold_total: string;
  stock_sold_qty: string;
  stock_sold_total: string;
  special_sold_qty: string;
  special_sold_total: string;
  sold_cost: string;
  cost_estimated: boolean;
  last_sold: Date | null;
}

// Merge all three "sources of customer stock" by productId:
//   - floor_qty           = InventoryPosition NOT at a customer-hold
//                           stock location (actual floor inventory)
//   - customer_loc_qty    = InventoryPosition AT a customer-hold
//                           stock location (e.g. "Customer Sofas")
//   - customer stock rows = received-but-not-delivered special orders
//                           (derived from PO -> order chain)
// The latter two feed the customerStock column. The first feeds onHand.
// A product can appear in any subset of the three.
function mergeOnHand(
  onHandRows: RawOnHandRow[],
  customerStockRows: RawCustomerStockRow[],
): OnHandRow[] {
  const floorMap = new Map<number, number>();
  const customerMap = new Map<number, number>();
  for (const r of onHandRows) {
    floorMap.set(r.productId, Number(r.floor_qty));
    const loc = Number(r.customer_loc_qty);
    if (loc > 0) customerMap.set(r.productId, loc);
  }
  for (const r of customerStockRows) {
    customerMap.set(r.productId, (customerMap.get(r.productId) ?? 0) + Number(r.customer_qty));
  }
  const onHandProductIds = new Set<number>([...floorMap.keys(), ...customerMap.keys()]);
  return Array.from(onHandProductIds).map((productId) => ({
    productId,
    floorQty: floorMap.get(productId) ?? 0,
    customerQty: customerMap.get(productId) ?? 0,
  }));
}

function mergeOnOrder(onOrderRows: RawOnOrderRow[]): Map<number, number> {
  const onOrderMap = new Map<number, number>();
  for (const row of onOrderRows) {
    if (row.productId == null) continue;
    const net = Number(row.on_order);
    if (net <= 0) continue;
    onOrderMap.set(row.productId, net);
  }
  return onOrderMap;
}

function mapSoldRows(soldRows: RawSoldRow[]): SoldRow[] {
  return soldRows
    .filter((r) => r.productId !== null)
    .map((r) => ({
      productId: r.productId as number,
      soldQty: Number(r.sold_qty),
      soldTotal: Number(r.sold_total),
      stockSoldQty: Number(r.stock_sold_qty),
      stockSoldTotal: Number(r.stock_sold_total),
      specialSoldQty: Number(r.special_sold_qty),
      specialSoldTotal: Number(r.special_sold_total),
      soldCost: Number(r.sold_cost),
      costEstimated: !!r.cost_estimated,
      lastSold: r.last_sold,
    }));
}

type ProductMeta = {
  id: number;
  productNumber: string | null;
  name: string | null;
  department: { id: number; name: string } | null;
  category: { id: number; name: string } | null;
  type: { id: number; name: string } | null;
  vendor: { id: number; name: string } | null;
};

// Assemble the per-product fact rows the rollup consumes. Skips orphan
// product references (a productId with no metadata row).
function buildFacts(
  productIds: Set<number>,
  productMeta: Map<number, ProductMeta>,
  floorStockMap: Map<number, number>,
  customerStockMap: Map<number, number>,
  onOrderMap: Map<number, number>,
  soldMap: Map<number, SoldRow>,
): ProductFact[] {
  const facts: ProductFact[] = [];
  for (const pid of productIds) {
    const meta = productMeta.get(pid);
    if (!meta) continue; // orphan product reference; skip
    const s = soldMap.get(pid);
    facts.push({
      productId: pid,
      productNumber: meta.productNumber ?? null,
      productName: meta.name ?? null,
      departmentId: meta.department?.id ?? null,
      departmentName: meta.department?.name ?? null,
      categoryId: meta.category?.id ?? null,
      categoryName: meta.category?.name ?? null,
      typeId: meta.type?.id ?? null,
      typeName: meta.type?.name ?? null,
      vendorId: meta.vendor?.id ?? null,
      vendorName: meta.vendor?.name ?? null,
      onHand: floorStockMap.get(pid) ?? 0,
      customerStock: customerStockMap.get(pid) ?? 0,
      onOrder: onOrderMap.get(pid) ?? 0,
      soldQty: s?.soldQty ?? 0,
      soldTotal: s?.soldTotal ?? 0,
      stockSoldQty: s?.stockSoldQty ?? 0,
      stockSoldTotal: s?.stockSoldTotal ?? 0,
      specialSoldQty: s?.specialSoldQty ?? 0,
      specialSoldTotal: s?.specialSoldTotal ?? 0,
      soldCost: s?.soldCost ?? 0,
      costEstimated: s?.costEstimated ?? false,
      lastSold: s?.lastSold ?? null,
    });
  }
  return facts;
}

export async function getBuyersSummary(prisma: PrismaClient, params: BuyersSummaryParams) {
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const startDate = parseDate(params.startDate) ?? defaultStart;
  const endDate = parseDate(params.endDate) ?? now;
  if (endDate < startDate) {
    throw new BuyersSummaryInputError("endDate must be on or after startDate");
  }
  const pivot: BuyersPivot = params.pivot === "vendor" ? "vendor" : "department";
  const storeId = typeof params.storeId === "number" && params.storeId > 0 ? params.storeId : null;
  const rollupFrames = params.rollupFrames === true;

  const rangeMs = endDate.getTime() - startDate.getTime();
  const weeksInRange = Math.max(1, Math.round(rangeMs / (7 * 24 * 60 * 60 * 1000)));

  // The four raw queries below are independent -- run them in parallel.
  // On a 365-day range this is a significant wall-clock win over the
  // previous sequential await chain.
  //
  // Prereqs (added by migration 20260424_buyers_report_indexes):
  //   SalesOrder(status, orderDate)          -- sold query range filter
  //   PurchaseOrderItem(orderLineItemId)     -- sold LATERAL + customer-stock derivation
  //   ReceivingRecord(purchaseOrderItemId)   -- on-order received subquery
  //   OrderLineItem(productId)               -- sold GROUP BY target
  const [onHandRows, customerStockRows, onOrderRows, soldRows] = (await Promise.all([
    // 1) Floor stock per product, AND stock-at-a-customer-hold-location.
    //    Splits InventoryPosition via stock-location name: anything at
    //    a StockLocation whose name starts with "Customer" (e.g.
    //    "Customer Sofas") is already spoken for and should NOT count
    //    as available-to-sell. InventoryPosition.salesOrderId exists in
    //    the schema but is 100% NULL in our data -- location name is
    //    the actual signal.
    prisma.$queryRawUnsafe(
      `
          SELECT ip."productId" AS "productId",
                 COALESCE(SUM(CASE WHEN sl.name ILIKE 'customer%' THEN 0 ELSE ip.quantity END), 0)::bigint AS floor_qty,
                 COALESCE(SUM(CASE WHEN sl.name ILIKE 'customer%' THEN ip.quantity ELSE 0 END), 0)::bigint AS customer_loc_qty
          FROM "InventoryPosition" ip
          LEFT JOIN "StockLocation" sl ON sl.id = ip."stockLocationId"
          WHERE 1=1
            ${storeId ? `AND ip."storeLocationId" = ${storeId}` : ""}
          GROUP BY ip."productId"
        `,
    ),
    // 2) Customer-allocated stock per product, derived from the PO
    //    receiving chain (since InventoryPosition.salesOrderId is
    //    unpopulated). A PO item's received units count as customer
    //    stock if any of THREE linkages place it on an open order:
    //      (a) PurchaseOrder.salesOrderId = open-order id  (whole PO)
    //      (b) PurchaseOrderItem.orderLineItemId = open line  (single line)
    //      (c) PurchaseOrderItem.externalPorNo = OrderLineItem.porNumber
    //          on an open line  (the POS's POR-chain linkage --
    //          sometimes only this is populated)
    //    The UNION of all three is ~349 POIs / 705 units in dev (vs
    //    329/684 without the POR-chain leg). `DISTINCT ON` picks a
    //    single row per POI so we don't double-count when multiple
    //    linkages apply.
    prisma.$queryRawUnsafe(
      `
          WITH received AS (
            SELECT "purchaseOrderItemId", SUM("quantityReceived") AS qty
            FROM "ReceivingRecord"
            GROUP BY "purchaseOrderItemId"
          ),
          allocated_pois AS (
            -- Issue #168 hardening (2026-05-15): paths (b) and (c) now
            -- require the matched OrderLineItem to be ON the same
            -- SalesOrder as the PurchaseOrder's allocation (po.salesOrderId).
            -- Previously a line and a PO could false-match on porNumber
            -- across totally unrelated orders — same root cause as the
            -- stock-vs-special classifier bug below. Path (a) is
            -- whole-PO-level so it already implies the link.
            SELECT DISTINCT ON (poi.id) poi.id, poi."productId", rcv.qty
            FROM "PurchaseOrderItem" poi
            JOIN received rcv ON rcv."purchaseOrderItemId" = poi.id
            JOIN "PurchaseOrder" po ON po.id = poi."purchaseOrderId"
            LEFT JOIN "OrderLineItem" li_direct
              ON li_direct.id = poi."orderLineItemId"
              AND li_direct."salesOrderId" = po."salesOrderId"
            LEFT JOIN "OrderLineItem" li_por
              ON li_por."porNumber" = poi."externalPorNo"
              AND poi."externalPorNo" IS NOT NULL
              AND poi."externalPorNo" != ''
              AND li_por."salesOrderId" = po."salesOrderId"
            WHERE poi."productId" IS NOT NULL
              AND rcv.qty > 0
              AND (
                -- (a) Whole PO allocated to an open order
                EXISTS (SELECT 1 FROM "SalesOrder" WHERE id = po."salesOrderId" AND status = 'ORDER')
                -- (b) Specific PO item allocated to an open line
                OR (li_direct.id IS NOT NULL
                    AND li_direct."lineItemStatus" != 'CANCELLED'
                    AND EXISTS (SELECT 1 FROM "SalesOrder" WHERE id = li_direct."salesOrderId" AND status = 'ORDER'))
                -- (c) Linked via the POS POR number
                OR (li_por.id IS NOT NULL
                    AND li_por."lineItemStatus" != 'CANCELLED'
                    AND EXISTS (SELECT 1 FROM "SalesOrder" WHERE id = li_por."salesOrderId" AND status = 'ORDER'))
              )
          )
          SELECT "productId",
                 SUM(qty)::bigint AS customer_qty
          FROM allocated_pois
          GROUP BY "productId"
        `,
    ),
    // 2) On-order per product: sum(orderedQuantity) - sum(received) across
    //    open POs. FLOOR-STOCK ONLY -- excludes POs/items allocated to a
    //    customer order. Store filter not applied (POs aren't store-scoped).
    //
    //    Prior version used a correlated subquery against ReceivingRecord
    //    per PO item (N^2-ish). Now pre-aggregates ReceivingRecord once
    //    in a CTE, LEFT JOINs by poi.id, aggregates to product level in
    //    a single pass.
    prisma.$queryRawUnsafe(
      `
          WITH received AS (
            SELECT "purchaseOrderItemId", SUM("quantityReceived") AS qty
            FROM "ReceivingRecord"
            GROUP BY "purchaseOrderItemId"
          )
          SELECT poi."productId" AS "productId",
                 SUM(poi."orderedQuantity" - COALESCE(rcv.qty, 0))::text AS on_order
          FROM "PurchaseOrderItem" poi
          JOIN "PurchaseOrder" po ON po.id = poi."purchaseOrderId"
          LEFT JOIN received rcv ON rcv."purchaseOrderItemId" = poi.id
          WHERE po.status IN ('DRAFT','SUBMITTED','CONFIRMED','RECEIVED_PARTIAL')
            AND po."salesOrderId" IS NULL
            AND poi."orderLineItemId" IS NULL
            AND poi."productId" IS NOT NULL
          GROUP BY poi."productId"
        `,
    ),
    // 3) Sold qty + $ per product in date range. Respects CLAUDE.md rule
    //    33 (exclude CANCELLED). netPrice and cost are LINE TOTALS --
    //    do not multiply by orderedQuantity (CLAUDE.md netPrice invariant).
    //
    //    Cost waterfall per line:
    //      1) li.cost > 0         -- actual line cost from the POS
    //      2) p.baseCost * qty    -- product-level cost set at receiving
    //      3) li.netPrice / 2     -- ESTIMATE when nothing else is known
    //
    //    Stock vs Special classification (Issue #168 fix, 2026-05-15):
    //    a line is "special" if there's a PurchaseOrderItem whose
    //    parent PurchaseOrder is allocated to THIS line's SalesOrder
    //    (same-SO requirement) AND either:
    //      (a) PurchaseOrderItem.orderLineItemId = li.id  (direct link)
    //      (b) PurchaseOrderItem.externalPorNo = li.porNumber
    //          (POR-chain link, tightened to non-empty strings)
    //
    //    The OLD logic checked (a) OR (b) without the same-SO gate.
    //    That produced massive false-positives on apparel: the POS
    //    assigns POR numbers as tracking IDs even for stock-floor
    //    sales, and unrelated POs with matching POR get false-matched.
    //    Empirical (prod backup 2026-05-14): of 5,705 Womens Apparel
    //    lines, 4,943 (87%) were classified "special" by the loose
    //    rules; only 175 (3%) actually were. The 12% direct-link
    //    rate was misleading too — only 175/1,450 of those had the
    //    parent PO truly allocated to the same SO.
    prisma.$queryRawUnsafe(
      `
          SELECT li."productId" AS "productId",
                 COALESCE(SUM(li."orderedQuantity"), 0)::text AS sold_qty,
                 COALESCE(SUM(li."netPrice"), 0)::text        AS sold_total,
                 COALESCE(SUM(
                   CASE WHEN poi_link.has_po THEN 0 ELSE li."orderedQuantity" END
                 ), 0)::text AS stock_sold_qty,
                 COALESCE(SUM(
                   CASE WHEN poi_link.has_po THEN 0 ELSE li."netPrice" END
                 ), 0)::text AS stock_sold_total,
                 COALESCE(SUM(
                   CASE WHEN poi_link.has_po THEN li."orderedQuantity" ELSE 0 END
                 ), 0)::text AS special_sold_qty,
                 COALESCE(SUM(
                   CASE WHEN poi_link.has_po THEN li."netPrice" ELSE 0 END
                 ), 0)::text AS special_sold_total,
                 COALESCE(SUM(
                   CASE
                     WHEN COALESCE(li."cost", 0) > 0 THEN li."cost"
                     WHEN COALESCE(p."baseCost", 0) > 0 THEN p."baseCost" * li."orderedQuantity"
                     ELSE li."netPrice" / 2.0
                   END
                 ), 0)::text AS sold_cost,
                 BOOL_OR(
                   COALESCE(li."cost", 0) <= 0
                   AND COALESCE(p."baseCost", 0) <= 0
                 ) AS cost_estimated,
                 MAX(so."orderDate") AS last_sold
          FROM "OrderLineItem" li
          JOIN "SalesOrder" so ON so.id = li."salesOrderId"
          LEFT JOIN "Product" p ON p.id = li."productId"
          LEFT JOIN LATERAL (
            SELECT TRUE AS has_po
            FROM "PurchaseOrderItem" poi
            JOIN "PurchaseOrder" po2 ON po2.id = poi."purchaseOrderId"
            WHERE po2."salesOrderId" = li."salesOrderId"
              AND po2."salesOrderId" IS NOT NULL
              AND (
                poi."orderLineItemId" = li.id
                OR (
                  poi."externalPorNo" IS NOT NULL
                  AND poi."externalPorNo" != ''
                  AND poi."externalPorNo" = li."porNumber"
                )
              )
            LIMIT 1
          ) poi_link ON TRUE
          WHERE so.status IN ('ORDER','FULFILLED','RETURNED')
            AND li."lineItemStatus" != 'CANCELLED'
            AND so."orderDate" >= $1
            AND so."orderDate" <= $2
            ${storeId ? `AND so."storeLocationId" = ${storeId}` : ""}
            AND li."productId" IS NOT NULL
          GROUP BY li."productId"
        `,
      startDate,
      endDate,
    ),
  ])) as [RawOnHandRow[], RawCustomerStockRow[], RawOnOrderRow[], RawSoldRow[]];

  const onHand = mergeOnHand(onHandRows, customerStockRows);
  const onOrderMap = mergeOnOrder(onOrderRows);
  const sold = mapSoldRows(soldRows);

  // Union of productIds across all three sources.
  const productIds = new Set<number>();
  for (const r of onHand) productIds.add(r.productId);
  for (const pid of onOrderMap.keys()) productIds.add(pid);
  for (const r of sold) productIds.add(r.productId);

  if (productIds.size === 0) {
    return {
      ...buildBuyersRollup([], pivot, weeksInRange),
      frameRollupActive: rollupFrames,
    };
  }

  // Load product metadata (dept/cat/vendor + leaf identifiers) for the
  // touched set. Leaf identifiers (productNumber + name) are used at the
  // deepest level of the 5-level drill-down tree.
  const products = await prisma.product.findMany({
    where: { id: { in: [...productIds] } },
    select: {
      id: true,
      productNumber: true,
      name: true,
      department: { select: { id: true, name: true } },
      category: { select: { id: true, name: true } },
      type: { select: { id: true, name: true } },
      vendor: { select: { id: true, name: true } },
    },
  });
  const productMeta = new Map(products.map((p) => [p.id, p]));
  const floorStockMap = new Map(onHand.map((r) => [r.productId, r.floorQty]));
  const customerStockMap = new Map(onHand.map((r) => [r.productId, r.customerQty]));
  const soldMap = new Map(sold.map((r) => [r.productId, r]));

  const facts = buildFacts(
    productIds,
    productMeta,
    floorStockMap,
    customerStockMap,
    onOrderMap,
    soldMap,
  );

  // Frame rollup is data-driven (see lib/frameRollup.ts). When enabled,
  // we classify each vendor by whether their SKUs share roots, and
  // collapse sibling products that share a frame under the same leaf.
  const frameInputs: FrameInput[] = facts.map((f) => ({
    productId: f.productId,
    productNumber: f.productNumber,
    vendorId: f.vendorId,
  }));
  const frameDecisions = buildFrameDecisions(frameInputs, rollupFrames);

  return {
    ...buildBuyersRollup(facts, pivot, weeksInRange, frameDecisions),
    frameRollupActive: rollupFrames,
  };
}

export async function getBuyersPositions(
  prisma: PrismaClient,
  productId: number,
): Promise<PositionsResponse> {
  const [product, rawPositions, onOrderAgg] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        productNumber: true,
        name: true,
        vendor: { select: { name: true } },
      },
    }),
    // Per-location breakdown with the same customer-hold-location
    // heuristic the main summary query uses (sl.name ILIKE 'customer%').
    prisma.$queryRawUnsafe<
      Array<{
        store_name: string | null;
        loc_code: string | null;
        loc_name: string | null;
        is_customer: boolean;
        qty: bigint;
      }>
    >(
      `
          SELECT
            store.name AS store_name,
            sl.code AS loc_code,
            sl.name AS loc_name,
            COALESCE(sl.name ILIKE 'customer%', FALSE) AS is_customer,
            COALESCE(SUM(ip.quantity), 0)::bigint AS qty
          FROM "InventoryPosition" ip
          LEFT JOIN "StoreLocation" store ON store.id = ip."storeLocationId"
          LEFT JOIN "StockLocation" sl ON sl.id = ip."stockLocationId"
          WHERE ip."productId" = $1
          GROUP BY store.name, sl.code, sl.name
          ORDER BY store.name NULLS LAST, sl.code NULLS LAST
        `,
      productId,
    ),
    // On-order summary: floor-stock POs only (exclude customer-allocated
    // via salesOrderId, orderLineItemId, externalPorNo). Earliest ESD
    // tells the buyer "first arrival is X weeks out".
    prisma.$queryRawUnsafe<Array<{ on_order: string; earliest_esd: Date | null }>>(
      `
          WITH received AS (
            SELECT "purchaseOrderItemId", SUM("quantityReceived") AS qty
            FROM "ReceivingRecord" GROUP BY "purchaseOrderItemId"
          )
          SELECT
            COALESCE(SUM(poi."orderedQuantity" - COALESCE(rcv.qty, 0)), 0)::text AS on_order,
            MIN(poi."estimatedShipDate") AS earliest_esd
          FROM "PurchaseOrderItem" poi
          JOIN "PurchaseOrder" po ON po.id = poi."purchaseOrderId"
          LEFT JOIN received rcv ON rcv."purchaseOrderItemId" = poi.id
          WHERE poi."productId" = $1
            AND po.status IN ('DRAFT','SUBMITTED','CONFIRMED','RECEIVED_PARTIAL')
            AND po."salesOrderId" IS NULL
            AND poi."orderLineItemId" IS NULL
            -- Issue #168 hardening (2026-05-15): the POR-chain exclusion
            -- below now requires the open-order line to match THIS poi's
            -- productId. the POS reuses POR strings across totally
            -- unrelated products (especially in apparel — see
            -- buyersReport.ts getBuyersSummary comment block); without the
            -- productId gate, legit floor-stock POs were being wrongly
            -- excluded as "customer-allocated."
            AND (poi."externalPorNo" IS NULL
                 OR poi."externalPorNo" = ''
                 OR NOT EXISTS (
                   SELECT 1 FROM "OrderLineItem" li2
                   JOIN "SalesOrder" so2 ON so2.id = li2."salesOrderId"
                   WHERE li2."porNumber" = poi."externalPorNo"
                     AND li2."productId" = poi."productId"
                     AND so2.status = 'ORDER'
                 ))
        `,
      productId,
    ),
  ]);

  if (!product) throw new BuyersPositionsNotFound("Product not found");

  let totalFloor = 0;
  let totalCustomer = 0;
  const positions: PositionRow[] = [];
  for (const r of rawPositions) {
    const qty = Number(r.qty);
    if (qty <= 0) continue;
    if (r.is_customer) totalCustomer += qty;
    else totalFloor += qty;
    positions.push({
      storeName: r.store_name,
      locationCode: r.loc_code,
      locationName: r.loc_name,
      floorQty: r.is_customer ? 0 : qty,
      customerQty: r.is_customer ? qty : 0,
    });
  }

  const onOrderNum = Number(onOrderAgg[0]?.on_order ?? 0);
  const earliestEsd = onOrderAgg[0]?.earliest_esd ?? null;

  return {
    productId: product.id,
    productNumber: product.productNumber,
    productName: product.name,
    vendorName: product.vendor?.name ?? null,
    totalFloor,
    totalCustomer,
    totalOnOrder: onOrderNum > 0 ? onOrderNum : 0,
    earliestEsd: earliestEsd ? earliestEsd.toISOString() : null,
    positions,
  };
}
