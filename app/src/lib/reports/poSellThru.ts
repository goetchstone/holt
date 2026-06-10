// /app/src/lib/reports/poSellThru.ts
//
// PO Sell-Thru report data assembly. Pick real purchase orders by number and
// see how much of what they delivered has since sold, with each PO line's
// sell-through clock starting at its own receive date and running to today.
//
// The pure windowing math lives in lib/reports/poSellThrough.ts; the frame
// rollup / stock-vs-special split / margins reuse lib/buyPerformance.ts
// untouched (sales are pre-windowed here, so the engine sees only valid
// sales). Read-only: PurchaseOrder / ReceivingRecord / Product / OrderLineItem.
//
// Consignment vendors are excluded by relation (any vendor with consignment
// receipts), not by name — consignment frames have no shared stems and are
// paid differently, so sell-through math is meaningless for them.

import type { PrismaClient } from "@prisma/client";
import { buildFrameDecisions, type FrameInput } from "@/lib/frameRollup";
import {
  computePerformance,
  type PerformanceDraft,
  type PerformanceSaleLine,
  type PerformanceReceiptLine,
  type ProductFrameIndex,
} from "@/lib/buyPerformance";
import {
  buildProductWindowStarts,
  windowSalesByReceipt,
  realizedRetailByFrame,
  type StockReceipt,
} from "@/lib/reports/poSellThrough";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

export interface PoSellThruParams {
  poNumbers: string[];
}

export interface PoSummary {
  poNumber: string;
  vendorName: string;
  orderDate: string;
  status: string;
  lineCount: number;
}

export interface PoSellThruRollup {
  totalQtyOrdered: number;
  totalQtyReceived: number;
  totalQtyStockSold: number;
  totalQtySpecialSold: number;
  totalRevenue: number;
  overallStockSellThrough: number;
  overallMargin: number;
  overallRealizedRetail: number | null;
}

export type PoSellThruFrame = ReturnType<typeof computePerformance>[number] & {
  realizedRetailRatio: number | null;
};

export interface PoSellThruResponse {
  pos: PoSummary[];
  notFound: string[];
  frames: PoSellThruFrame[];
  rollup: PoSellThruRollup;
}

interface SelectedPo {
  id: number;
  poNumber: string;
  vendorId: number;
  vendorName: string;
  orderDate: Date;
  status: string;
  items: { productId: number | null; orderedQuantity: number; unitCost: number }[];
}

export function parsePoNumbers(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export async function getPoSellThru(
  prisma: PrismaClient,
  params: PoSellThruParams,
): Promise<PoSellThruResponse> {
  const requested = Array.from(new Set(params.poNumbers.map((s) => s.trim()).filter(Boolean)));
  if (requested.length === 0) {
    return { pos: [], notFound: [], frames: [], rollup: emptyRollup() };
  }

  const selected = await loadSelectedPos(prisma, requested);
  const foundNumbers = new Set(selected.map((p) => p.poNumber.toUpperCase()));
  const notFound = requested.filter((n) => !foundNumbers.has(n.toUpperCase()));

  if (selected.length === 0) {
    return { pos: [], notFound, frames: [], rollup: emptyRollup() };
  }

  const poIds = selected.map((p) => p.id);
  const { stockReceipts, receipts, earliestReceiptOverall } = await loadReceipts(prisma, poIds);

  // Frame universe: every product for the selected POs' vendors, so frame-mate
  // variants sold as special orders roll into the same frame.
  const vendorIds = Array.from(new Set(selected.map((p) => p.vendorId)));
  const { productToFrame, frameLabelByKey, baseRetailByProduct } = await buildFrameUniverse(
    prisma,
    vendorIds,
  );

  const stockProductIds = new Set<number>(
    selected.flatMap((p) => p.items.map((i) => i.productId).filter((x): x is number => x !== null)),
  );

  // Drafts = the PO line items; qtyOrdered drives the sell-through denominator.
  const drafts: PerformanceDraft[] = selected.flatMap((p) =>
    p.items
      .filter((i) => i.productId !== null)
      .map((i) => {
        const frame = productToFrame.get(i.productId as number);
        return {
          draftId: 0,
          qty: i.orderedQuantity,
          costPerUnit: i.unitCost,
          retailPerUnit: 0,
          fulfilledProductId: i.productId,
          frameKey: frame ?? null,
          frameLabel: (frame && frameLabelByKey.get(frame)) || frame || "(unclassified)",
        } satisfies PerformanceDraft;
      }),
  );

  const windowStartByProduct = buildProductWindowStarts(stockReceipts, productToFrame);
  const sales = await loadWindowedSales(prisma, productToFrame, windowStartByProduct);

  const daysSinceReceived =
    earliestReceiptOverall === null
      ? 0
      : Math.max(
          0,
          Math.floor((Date.now() - earliestReceiptOverall.getTime()) / (24 * 60 * 60 * 1000)),
        );

  const frames = computePerformance(
    drafts,
    sales,
    productToFrame,
    { daysSinceBuyExported: daysSinceReceived, stockProductIds },
    receipts,
  );

  const realized = realizedRetailByFrame(sales, productToFrame, baseRetailByProduct);
  const framesOut: PoSellThruFrame[] = frames.map((f) => {
    const rr = realized.get(f.frameKey);
    return {
      ...f,
      realizedRetailRatio: rr && rr.fullRetail > 0 ? rr.soldRevenue / rr.fullRetail : null,
    };
  });

  return {
    pos: selected.map((p) => ({
      poNumber: p.poNumber,
      vendorName: p.vendorName,
      orderDate: p.orderDate.toISOString(),
      status: p.status,
      lineCount: p.items.length,
    })),
    notFound,
    frames: framesOut,
    rollup: buildRollup(frames, realized),
  };
}

async function loadSelectedPos(
  prisma: PrismaClient,
  poNumbers: readonly string[],
): Promise<SelectedPo[]> {
  const rows = await prisma.purchaseOrder.findMany({
    where: {
      poNumber: { in: [...poNumbers] },
      // Exclude consignment vendors by relation, not by name (white-label).
      vendor: { consignmentReceipts: { none: {} } },
    },
    select: {
      id: true,
      poNumber: true,
      vendorId: true,
      vendor: { select: { name: true } },
      orderDate: true,
      status: true,
      lineItems: {
        select: { productId: true, orderedQuantity: true, unitCost: true },
      },
    },
  });
  return rows.map((p) => ({
    id: p.id,
    poNumber: p.poNumber,
    vendorId: p.vendorId,
    vendorName: p.vendor?.name ?? "",
    orderDate: p.orderDate,
    status: String(p.status),
    items: p.lineItems.map((i) => ({
      productId: i.productId,
      orderedQuantity: Number(i.orderedQuantity.toString()),
      unitCost: Number(i.unitCost.toString()),
    })),
  }));
}

async function loadReceipts(
  prisma: PrismaClient,
  poIds: readonly number[],
): Promise<{
  stockReceipts: StockReceipt[];
  receipts: PerformanceReceiptLine[];
  earliestReceiptOverall: Date | null;
}> {
  const rows = await prisma.receivingRecord.findMany({
    where: { purchaseOrderId: { in: [...poIds] } },
    select: {
      receivedDate: true,
      quantityReceived: true,
      purchaseOrderItem: { select: { productId: true } },
    },
  });
  const stockReceipts: StockReceipt[] = [];
  const receipts: PerformanceReceiptLine[] = [];
  let earliest: Date | null = null;
  for (const r of rows) {
    const productId = r.purchaseOrderItem?.productId;
    if (productId === null || productId === undefined) continue;
    stockReceipts.push({ productId, receivedDate: r.receivedDate });
    receipts.push({ productId, qty: Number(r.quantityReceived.toString()) });
    if (earliest === null || r.receivedDate < earliest) earliest = r.receivedDate;
  }
  return { stockReceipts, receipts, earliestReceiptOverall: earliest };
}

async function buildFrameUniverse(
  prisma: PrismaClient,
  vendorIds: readonly number[],
): Promise<{
  productToFrame: ProductFrameIndex;
  frameLabelByKey: Map<string, string>;
  baseRetailByProduct: Map<number, number>;
}> {
  if (vendorIds.length === 0) {
    return {
      productToFrame: new Map(),
      frameLabelByKey: new Map(),
      baseRetailByProduct: new Map(),
    };
  }
  const products = await prisma.product.findMany({
    where: { vendorId: { in: [...vendorIds] } },
    select: { id: true, productNumber: true, vendorId: true, baseRetail: true },
  });
  const inputs: FrameInput[] = products.map((p) => ({
    productId: p.id,
    productNumber: p.productNumber ?? null,
    vendorId: p.vendorId,
  }));
  const decisions = buildFrameDecisions(inputs, true);
  const productToFrame = new Map<number, string>();
  const frameLabelByKey = new Map<string, string>();
  for (const [pid, d] of decisions) {
    productToFrame.set(pid, d.frameKey);
    if (!frameLabelByKey.has(d.frameKey)) frameLabelByKey.set(d.frameKey, d.frameLabel);
  }
  const baseRetailByProduct = new Map<number, number>(
    products.map((p) => [p.id, p.baseRetail === null ? 0 : Number(p.baseRetail.toString())]),
  );
  return { productToFrame, frameLabelByKey, baseRetailByProduct };
}

async function loadWindowedSales(
  prisma: PrismaClient,
  productToFrame: ProductFrameIndex,
  windowStartByProduct: ReadonlyMap<number, Date>,
): Promise<PerformanceSaleLine[]> {
  const productIds = Array.from(productToFrame.keys());
  if (productIds.length === 0 || windowStartByProduct.size === 0) return [];

  // Broad SQL floor = earliest window start; per-product windows tighten after.
  let floor: Date | null = null;
  for (const d of windowStartByProduct.values()) {
    if (floor === null || d < floor) floor = d;
  }

  const rows = await prisma.orderLineItem.findMany({
    where: {
      productId: { in: productIds },
      lineItemStatus: { not: "CANCELLED" },
      salesOrder: {
        status: { in: [...SALES_REVENUE_STATUSES] },
        ...(floor ? { orderDate: { gte: floor } } : {}),
      },
    },
    select: {
      productId: true,
      orderedQuantity: true,
      netPrice: true,
      cost: true,
      salesOrder: { select: { orderDate: true } },
    },
  });

  const sales: PerformanceSaleLine[] = rows.map((s) => ({
    productId: s.productId as number,
    qty: Number(s.orderedQuantity.toString()),
    netPrice: Number(s.netPrice.toString()),
    cost: s.cost === null ? null : Number(s.cost.toString()),
    orderDate: s.salesOrder?.orderDate ?? null,
  }));

  return windowSalesByReceipt(sales, windowStartByProduct);
}

function emptyRollup(): PoSellThruRollup {
  return {
    totalQtyOrdered: 0,
    totalQtyReceived: 0,
    totalQtyStockSold: 0,
    totalQtySpecialSold: 0,
    totalRevenue: 0,
    overallStockSellThrough: 0,
    overallMargin: 0,
    overallRealizedRetail: null,
  };
}

function buildRollup(
  frames: ReturnType<typeof computePerformance>,
  realized: ReadonlyMap<string, { soldRevenue: number; fullRetail: number }>,
): PoSellThruRollup {
  const totalQtyOrdered = frames.reduce((a, f) => a + f.qtyOrdered, 0);
  const totalQtyStockSold = frames.reduce((a, f) => a + f.qtyStockSold, 0);
  const totalRevenue = frames.reduce((a, f) => a + f.revenue, 0);
  const totalCostOfSold = frames.reduce((a, f) => a + f.costOfSold, 0);
  let soldRevenue = 0;
  let fullRetail = 0;
  for (const r of realized.values()) {
    soldRevenue += r.soldRevenue;
    fullRetail += r.fullRetail;
  }
  return {
    totalQtyOrdered,
    totalQtyReceived: frames.reduce((a, f) => a + f.qtyReceived, 0),
    totalQtyStockSold,
    totalQtySpecialSold: frames.reduce((a, f) => a + f.qtySpecialSold, 0),
    totalRevenue,
    overallStockSellThrough: totalQtyOrdered === 0 ? 0 : totalQtyStockSold / totalQtyOrdered,
    overallMargin:
      totalRevenue === 0 ? 0 : Math.max(0, totalRevenue - totalCostOfSold) / totalRevenue,
    overallRealizedRetail: fullRetail > 0 ? soldRevenue / fullRetail : null,
  };
}
