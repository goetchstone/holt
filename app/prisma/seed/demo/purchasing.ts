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

export interface PurchasingResult {
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

  return { purchaseOrdersCreated, receivingRecordsCreated };
}
