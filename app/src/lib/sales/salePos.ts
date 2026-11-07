// /app/src/lib/sales/salePos.ts
//
// A sale and its purchase orders (DECISIONS 51): raising them for a special order, and
// keeping them in step when the sale is cancelled or changed.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createNumberedPurchaseOrder } from "@/lib/purchasing/poNumber";
import { expectedArrival } from "@/lib/vendorLeadTime";
import { poStanding, type PoDecision, type PoStanding } from "./salePosShared";

type Tx = Prisma.TransactionClient;

/**
 * Raises a draft PO, one per vendor, for each active special-order line that has none.
 * Floor stock needs none, nor a cancelled or zero line (rules 31, 33). A line an imported
 * PO covers carries its number, and an order with an imported PO's unlinked lines is left
 * alone, since nothing says which lines those cover.
 */
export async function raiseSpecialOrderPos(orderId: number): Promise<void> {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      salesperson: true,
      lineItems: {
        select: {
          id: true,
          source: true,
          lineItemStatus: true,
          orderedQuantity: true,
          porNumber: true,
          cost: true,
          purchaseOrderItems: { select: { id: true } },
          product: {
            select: { id: true, vendorId: true, productNumber: true, name: true, baseCost: true },
          },
        },
      },
      purchaseOrders: {
        select: { lineItems: { select: { orderLineItemId: true } } },
      },
    },
  });

  const unlinked = order.purchaseOrders.some((po) =>
    po.lineItems.some((item) => item.orderLineItemId === null),
  );
  if (unlinked) return;

  const byVendor = new Map<
    number,
    Prisma.PurchaseOrderItemUncheckedCreateWithoutPurchaseOrderInput[]
  >();
  for (const line of order.lineItems) {
    if (line.source === "FLOOR" || line.lineItemStatus !== "ACTIVE") continue;
    if (Number(line.orderedQuantity) <= 0) continue;
    if (line.porNumber || line.purchaseOrderItems.length > 0) continue;
    const product = line.product;
    if (!product?.vendorId) continue;
    // The line's configured cost if it has one, otherwise the catalog's.
    const lineCost = Number(line.cost || 0);
    const items = byVendor.get(product.vendorId) ?? [];
    items.push({
      // Its goods arrive committed to this line while it's active, and free once it isn't.
      orderLineItemId: line.id,
      productId: product.id,
      partNo: product.productNumber,
      productName: product.name,
      orderedQuantity: line.orderedQuantity,
      unitCost: lineCost > 0 ? lineCost : Number(product.baseCost || 0),
    });
    byVendor.set(product.vendorId, items);
  }
  if (byVendor.size === 0) return;

  const now = new Date();
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: [...byVendor.keys()] } },
    select: { id: true, leadTimeDays: true },
  });
  const leadTimes = new Map(vendors.map((v) => [v.id, v.leadTimeDays]));
  for (const [vendorId, items] of byVendor) {
    await createNumberedPurchaseOrder(
      prisma,
      {
        vendorId,
        salesOrderId: orderId,
        status: "DRAFT",
        orderDate: now,
        expectedDelivery: expectedArrival(now, leadTimes.get(vendorId)),
        createdBy: order.salesperson || null,
        lineItems: { create: items },
      },
      now,
    );
  }
}

export interface SalePoLine {
  id: number;
  orderedQuantity: number;
  received: number;
}

export interface SalePo {
  id: number;
  poNumber: string;
  vendor: string;
  status: string;
  standing: PoStanding;
  /** The vendor has a copy, so someone should tell them it's off. */
  sentToVendor: boolean;
  /** The lines on it for this sale. */
  lines: SalePoLine[];
}

const PO_SELECT = {
  id: true,
  poNumber: true,
  status: true,
  salesOrderId: true,
  vendor: { select: { name: true } },
  lineItems: {
    select: {
      id: true,
      orderedQuantity: true,
      orderLineItemId: true,
      orderLineItem: { select: { salesOrderId: true } },
      receivingRecords: { select: { quantityReceived: true } },
    },
  },
} satisfies Prisma.PurchaseOrderSelect;

type PoRow = Prisma.PurchaseOrderGetPayload<{ select: typeof PO_SELECT }>;

function toSalePo(po: PoRow, belongs: (item: PoRow["lineItems"][number]) => boolean): SalePo {
  return {
    id: po.id,
    poNumber: po.poNumber,
    vendor: po.vendor.name,
    status: po.status,
    standing: poStanding(po.status),
    sentToVendor: po.status !== "DRAFT",
    lines: po.lineItems.filter(belongs).map((item) => ({
      id: item.id,
      orderedQuantity: Number(item.orderedQuantity),
      received: item.receivingRecords.reduce((sum, r) => sum + Number(r.quantityReceived), 0),
    })),
  };
}

/** The POs for a sale still in play: raised for it, or with a line for one of its lines. */
export async function readSalePos(db: Tx, orderId: number): Promise<SalePo[]> {
  const pos = await db.purchaseOrder.findMany({
    where: {
      isReturn: false,
      status: { notIn: ["CANCELLED", "SHORT_CLOSED"] },
      OR: [
        { salesOrderId: orderId },
        { lineItems: { some: { orderLineItem: { salesOrderId: orderId } } } },
      ],
    },
    select: PO_SELECT,
    orderBy: { id: "asc" },
  });
  return pos.map((po) =>
    toSalePo(
      po,
      (item) =>
        item.orderLineItem?.salesOrderId === orderId ||
        (po.salesOrderId === orderId && item.orderLineItemId === null),
    ),
  );
}

/** The POs with a line for this one order line. */
export async function readLinePos(db: Tx, lineItemId: number): Promise<SalePo[]> {
  const pos = await db.purchaseOrder.findMany({
    where: {
      isReturn: false,
      status: { notIn: ["CANCELLED", "SHORT_CLOSED"] },
      lineItems: { some: { orderLineItemId: lineItemId } },
    },
    select: PO_SELECT,
    orderBy: { id: "asc" },
  });
  return pos.map((po) => toSalePo(po, (item) => item.orderLineItemId === lineItemId));
}

/**
 * Takes these lines off the PO: down to what's already arrived. Once nothing is left to
 * come, the PO is closed: cancelled if nothing arrived, short-closed if some did.
 */
export async function dropPoLines(tx: Tx, po: SalePo, actor: string | null): Promise<void> {
  for (const line of po.lines) {
    await tx.purchaseOrderItem.update({
      where: { id: line.id },
      data: { orderedQuantity: line.received },
    });
  }
  const all = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId: po.id },
    select: {
      orderedQuantity: true,
      receivingRecords: { select: { quantityReceived: true } },
    },
  });
  const receivedOf = (item: (typeof all)[number]) =>
    item.receivingRecords.reduce((sum, r) => sum + Number(r.quantityReceived), 0);
  if (all.some((item) => Number(item.orderedQuantity) > receivedOf(item))) return;
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: {
      status: all.some((item) => receivedOf(item) > 0) ? "SHORT_CLOSED" : "CANCELLED",
      updatedBy: actor,
    },
  });
}

/**
 * The whole sale is off and the store keeps what's on this PO: it stops being for a
 * customer and comes in like any stock order, so it counts as on order at the store.
 */
export async function keepPoAsStock(
  tx: Tx,
  po: SalePo,
  storeLocationId: number | null,
  actor: string | null,
): Promise<void> {
  await tx.purchaseOrderItem.updateMany({
    where: { id: { in: po.lines.map((line) => line.id) } },
    data: { orderLineItemId: null },
  });
  const current = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    select: { shipToLocationId: true },
  });
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: {
      salesOrderId: null,
      shipToLocationId: current.shipToLocationId ?? storeLocationId,
      updatedBy: actor,
    },
  });
}

/** How a PO's lines leave a sale that's cancelled: what was decided, or what its standing says. */
export function poOutcome(po: SalePo, decision: PoDecision | undefined): "DROP" | "KEEP" | "NONE" {
  if (po.standing === "OPEN") return "DROP";
  if (po.standing === "ACKNOWLEDGED") return decision === "VENDOR_AGREED" ? "DROP" : "KEEP";
  return "NONE";
}
