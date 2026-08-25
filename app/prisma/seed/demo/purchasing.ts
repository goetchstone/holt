// app/prisma/seed/demo/purchasing.ts
//
// PurchaseOrders + PurchaseOrderItems + ReceivingRecords against the
// catalog's real vendors — spread across the seed window with a realistic
// status mix (most received, some still in flight, a few short-closed or
// cancelled).

import type { PrismaClient, PurchaseOrderStatus } from "@prisma/client";
import type { Rng } from "./rng";
import { chance, pick, randInt, round2, subRng, weightedPick } from "./rng";
import type { CatalogProduct } from "./catalog";
import type { StoreSetup } from "./locations";
import type { SeededStaffMember } from "./staff";

const SEED_ACTOR = "seed:demo";

const STATUS_MIX: readonly (readonly [PurchaseOrderStatus, number])[] = [
  ["RECEIVED_FULL", 55],
  ["RECEIVED_PARTIAL", 12],
  ["CONFIRMED", 12],
  ["SUBMITTED", 10],
  ["DRAFT", 6],
  ["SHORT_CLOSED", 3],
  ["CANCELLED", 2],
];

/**
 * When a special order is due in, spread across the buckets the Delivery
 * Planner groups by. A planner where everything lands in one bucket cannot
 * show that it groups, and "No ESD" is the row that matters most: a vendor who
 * has not given a ship date is the one the buyer has to chase.
 */
function expectedArrival(rng: Rng, today: Date): Date | null {
  const roll = randInt(rng, 1, 100);
  if (roll <= 20) return null; // vendor has not committed to a date
  const days =
    roll <= 45 ? randInt(rng, 1, 6) : roll <= 70 ? randInt(rng, 7, 13) : randInt(rng, 14, 28);
  return new Date(today.getTime() + days * 86_400_000);
}

export interface PurchasingResult {
  /** POs raised against a customer order -- the special-order chain. */
  specialOrdersCreated: number;
  purchaseOrdersCreated: number;
  receivingRecordsCreated: number;
}

export async function seedPurchasing(
  prisma: PrismaClient,
  rng: Rng,
  window: { start: Date; end: Date },
  products: readonly CatalogProduct[],
  stores: readonly StoreSetup[],
  warehouseStaff: readonly SeededStaffMember[],
  purchaseOrderCount: number,
  /** Today, for dating special orders relative to now rather than to the
   *  historical window the stock POs live in. */
  today: Date,
): Promise<PurchasingResult> {
  const poRng = subRng(rng, "purchasing");

  const productsByVendor = new Map<number, CatalogProduct[]>();
  for (const p of products) {
    const arr = productsByVendor.get(p.vendorId);
    if (arr) arr.push(p);
    else productsByVendor.set(p.vendorId, [p]);
  }
  const vendorIds = [...productsByVendor.keys()];

  const receiver = warehouseStaff[0];
  const spanMs = window.end.getTime() - window.start.getTime();

  let purchaseOrdersCreated = 0;
  let receivingRecordsCreated = 0;

  for (let i = 0; i < purchaseOrderCount; i++) {
    const vendorId = pick(poRng, vendorIds);
    const vendorProducts = productsByVendor.get(vendorId)!;
    const orderDate = new Date(window.start.getTime() + randInt(poRng, 0, spanMs));
    const status = weightedPick(poRng, STATUS_MIX);
    const yy = orderDate.getUTCFullYear().toString().slice(-2);
    const mm = (orderDate.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = orderDate.getUTCDate().toString().padStart(2, "0");
    const poNumber = `PO-${yy}${mm}${dd}-${(i + 1).toString().padStart(4, "0")}`;

    const lineCount = randInt(poRng, 1, 4);
    const lines = Array.from({ length: lineCount }, () => pick(poRng, vendorProducts));

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        vendorId,
        orderDate,
        expectedDelivery: new Date(orderDate.getTime() + randInt(poRng, 14, 70) * 86_400_000),
        status,
        notes:
          status === "SHORT_CLOSED"
            ? "Vendor discontinued item — short-closed remaining balance."
            : null,
        createdBy: SEED_ACTOR,
        lineItems: {
          create: lines.map((product) => {
            const orderedQuantity = randInt(poRng, 1, 6);
            const unitCost = round2(product.baseCost * (0.95 + poRng() * 0.1));
            return {
              productId: product.id,
              partNo: product.productNumber,
              productName: product.name,
              orderedQuantity,
              unitCost,
            };
          }),
        },
      },
      include: { lineItems: true },
    });
    purchaseOrdersCreated += 1;

    const isReceived = status === "RECEIVED_FULL" || status === "RECEIVED_PARTIAL";
    if (isReceived) {
      const store = pick(poRng, stores);
      for (const item of po.lineItems) {
        const fullyReceive = status === "RECEIVED_FULL" || chance(poRng, 0.6);
        const qty = fullyReceive
          ? Number(item.orderedQuantity)
          : Math.max(1, Math.floor(Number(item.orderedQuantity) * (0.3 + poRng() * 0.4)));
        const receivedDate = new Date(orderDate.getTime() + randInt(poRng, 10, 60) * 86_400_000);
        await prisma.receivingRecord.create({
          data: {
            purchaseOrderItemId: item.id,
            purchaseOrderId: po.id,
            quantityReceived: qty,
            receivedDate: receivedDate > window.end ? window.end : receivedDate,
            receiverUserId: receiver.userId,
            destinationLocationId: store.id,
            destinationStockLocationId: store.backStockLocationId,
            condition: chance(poRng, 0.95) ? "OK" : "Damaged",
            tagsPrinted: true,
          },
        });
        receivingRecordsCreated += 1;
      }
    }
  }

  // ---- SPECIAL ORDERS: a PO raised BECAUSE a customer bought something ----
  //
  // Every PO above is a stock buy. That left the Delivery Planner empty, because
  // it deliberately shows only POs carrying a `salesOrderId` -- the ones where a
  // named customer is waiting on a named vendor. That chain is the whole
  // furniture special-order thought process: the customer orders it, the buyer
  // raises it with the vendor, the warehouse watches it land, dispatch schedules
  // it, the driver delivers it, and only then is it a sale.
  //
  // Raised against orders whose goods have not arrived (dispatchStatus
  // PO_PLACED), which is exactly what that status means.
  const awaitingGoods = await prisma.salesOrder.findMany({
    where: { dispatchStatus: "PO_PLACED", deliveredAt: null },
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      lineItems: {
        where: { productId: { not: null } },
        select: { id: true, productId: true, orderedQuantity: true },
      },
    },
    orderBy: { orderDate: "desc" },
    take: 45,
  });

  let specialOrdersCreated = 0;
  for (const [i, order] of awaitingGoods.entries()) {
    const lines = order.lineItems.filter((li) => li.productId != null);
    if (lines.length === 0) continue;

    const product = products.find((pr) => pr.id === lines[0].productId);
    if (!product) continue;

    // A special order goes to the vendor who makes the thing, not a random one.
    const vendorId = product.vendorId;
    const arrival = expectedArrival(poRng, today);

    await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-SO-${order.orderno.replace(/[^0-9]/g, "").slice(-6)}-${i + 1}`,
        vendorId,
        salesOrderId: order.id,
        orderDate: new Date(order.orderDate ?? today),
        expectedDelivery: arrival,
        estimatedShipDate: arrival,
        // Nothing received yet -- these are the ones still coming.
        status: chance(poRng, 0.6) ? "CONFIRMED" : "SUBMITTED",
        vendorAckNumber: chance(poRng, 0.5) ? `ACK-${randInt(poRng, 10000, 99999)}` : null,
        notes: "Special order — customer waiting.",
        createdBy: SEED_ACTOR,
        lineItems: {
          create: lines.map((li) => {
            const p = products.find((pr) => pr.id === li.productId);
            return {
              productId: li.productId!,
              orderLineItemId: li.id,
              partNo: p?.productNumber ?? null,
              productName: p?.name ?? null,
              orderedQuantity: Number(li.orderedQuantity ?? 1),
              unitCost: round2((p?.baseCost ?? 0) * (0.95 + poRng() * 0.1)),
            };
          }),
        },
      },
    });
    purchaseOrdersCreated += 1;
    specialOrdersCreated += 1;
  }

  return { purchaseOrdersCreated, receivingRecordsCreated, specialOrdersCreated };
}
