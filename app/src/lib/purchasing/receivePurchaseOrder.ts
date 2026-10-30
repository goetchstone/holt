// /app/src/lib/purchasing/receivePurchaseOrder.ts
//
// Goods in against a purchase order: one function for the Receive PO screen
// and the handheld receive (rule 42), in the caller's transaction. For each
// line received it writes the ReceivingRecord, puts the goods into stock
// (lib/inventory/receiving.ts: the chosen place, the store's receiving place,
// or quarantine; committed to the order the line was raised for), and then
// recalculates the PO's status (rule 39: zero-quantity lines count on neither
// side).
//
// An incomplete set -- a multi-box unit some of whose boxes did not arrive --
// is received as a unit into quarantine with a BoxNote naming the missing
// boxes (lib/inventory/boxes.ts). It counts toward what the PO line received.
//
// Each receipt records the place its units landed and the landed unit cost they
// brought into their product's average (GAP-02, lib/purchasing/landedCost.ts),
// so it can be taken back exactly (lib/purchasing/unreceive.ts).

import type { Prisma } from "@prisma/client";
import { lockProducts } from "@/lib/inventory/ledger";
import { receiveIntoStock } from "@/lib/inventory/receiving";
import { landingPlaceId } from "@/lib/inventory/places";
import { parseQty } from "@/lib/inventory/qtyInput";
import { nativeReceiptStatus } from "@/lib/purchasing/receiptStatus";
import { INCOMPLETE_SET_CONDITION } from "@/lib/purchasing/receiptConditions";
import { averageInReceipt, poLandedUnitCosts } from "@/lib/purchasing/landedCost";

type Tx = Prisma.TransactionClient;

export class ReceiveError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export interface ReceiveItem {
  purchaseOrderItemId: number;
  quantityReceived: number;
  destinationStockLocationId?: number | null;
  condition?: string;
  printTag?: boolean;
  variantUpc?: string;
  /** Multi-box units that arrived short of boxes, each received as one unit. */
  incompleteSets?: { missing: number[] }[];
}

export interface ReceiveResult {
  receivingRecords: {
    id: number;
    purchaseOrderItemId: number;
    quantityReceived: number;
    condition: string | null;
    tagsPrinted: boolean;
  }[];
  newStatus: string;
  printItems: { productId: number; quantity: number }[];
  /** BoxNote ids opened for incomplete sets. */
  incompleteNotes: number[];
}

export async function receivePurchaseOrder(
  tx: Tx,
  args: {
    poId: number;
    storeLocationId: number;
    items: ReceiveItem[];
    receiverUserId: string;
    actor: string | null;
    actionKey?: string | null;
  },
): Promise<ReceiveResult> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: args.poId },
    include: {
      lineItems: {
        include: {
          product: { select: { id: true, boxesPerUnit: true } },
          productVariant: { select: { id: true, upc: true } },
        },
      },
    },
  });
  if (!po) throw new ReceiveError("Purchase order not found.", 404);
  if (po.status === "CANCELLED") throw new ReceiveError("Cannot receive against a cancelled PO.");

  const poItemIds = new Set(po.lineItems.map((li) => li.id));
  for (const item of args.items) {
    if (!poItemIds.has(item.purchaseOrderItemId)) {
      throw new ReceiveError(
        `Item ${item.purchaseOrderItemId} does not belong to PO ${po.poNumber}.`,
      );
    }
    const sets = item.incompleteSets ?? [];
    // A part roll arrives as a length: parsed, never truncated. Zero is fine
    // when everything that came was an incomplete set.
    const quantity =
      sets.length > 0 && Number(item.quantityReceived) === 0 ? 0 : parseQty(item.quantityReceived);
    if (quantity == null) throw new ReceiveError("quantityReceived must be positive.");
    item.quantityReceived = quantity;
  }

  // Lock every product on this receipt once, in ascending order, before any
  // stock moves. Locking them one at a time in request order could take 9
  // then 2 while a sale takes 2 then 9, and deadlock.
  await lockProducts(
    tx,
    args.items
      .map((item) => po.lineItems.find((li) => li.id === item.purchaseOrderItemId)?.product?.id)
      .filter((id): id is number => id != null),
  );

  const receivingRecords: ReceiveResult["receivingRecords"] = [];
  const printItems: ReceiveResult["printItems"] = [];
  const incompleteNotes: number[] = [];
  // Each line's landed unit cost, from the PO's charges as they stand now.
  const landed = await poLandedUnitCosts(tx, args.poId);

  /** Into the product's average, then into stock; the place it landed. */
  const putAway = async (
    poItem: (typeof po.lineItems)[number],
    productId: number,
    quantity: number,
    item: { destinationStockLocationId?: number | null },
    condition: string | null | undefined,
  ): Promise<number> => {
    const landedCost = landed.get(poItem.id);
    if (landedCost !== undefined) {
      await averageInReceipt(tx, { productId, quantity, unitCost: landedCost });
    }
    const put = await receiveIntoStock(tx, {
      po,
      poItem,
      productId,
      quantity,
      storeLocationId: args.storeLocationId,
      stockLocationId: item.destinationStockLocationId,
      condition,
      actor: args.actor,
      actionKey: args.actionKey,
    });
    return put.stockLocationId;
  };

  const record = async (
    item: ReceiveItem,
    quantity: number,
    condition: string | null,
    landedAt: number | null,
  ): Promise<void> => {
    const r = await tx.receivingRecord.create({
      data: {
        purchaseOrderItemId: item.purchaseOrderItemId,
        purchaseOrderId: args.poId,
        quantityReceived: quantity,
        receiverUserId: args.receiverUserId,
        destinationLocationId: args.storeLocationId,
        destinationStockLocationId: landedAt ?? (item.destinationStockLocationId || null),
        condition,
        tagsPrinted: item.printTag ?? false,
        landedUnitCost: landed.get(item.purchaseOrderItemId) ?? null,
      },
    });
    receivingRecords.push({
      id: r.id,
      purchaseOrderItemId: r.purchaseOrderItemId,
      quantityReceived: Number(r.quantityReceived),
      condition: r.condition,
      tagsPrinted: r.tagsPrinted,
    });
  };

  for (const item of args.items) {
    const poItem = po.lineItems.find((li) => li.id === item.purchaseOrderItemId);
    if (!poItem) continue;

    if (item.quantityReceived > 0) {
      const landedAt = poItem.product
        ? await putAway(poItem, poItem.product.id, item.quantityReceived, item, item.condition)
        : null;
      await record(item, item.quantityReceived, item.condition || null, landedAt);

      // Update variant UPC if provided during receiving
      if (item.variantUpc && poItem.productVariant && !poItem.productVariant.upc) {
        await tx.productVariant.update({
          where: { id: poItem.productVariant.id },
          data: { upc: item.variantUpc },
        });
      }

      if (poItem.product && item.printTag) {
        printItems.push({ productId: poItem.product.id, quantity: item.quantityReceived });
      }
    }

    for (const set of item.incompleteSets ?? []) {
      if (!poItem.product) throw new ReceiveError("Only a catalog product can arrive as boxes.");
      const boxesPerUnit = Math.max(1, poItem.product.boxesPerUnit ?? 1);
      if (boxesPerUnit < 2 || set.missing.length === 0 || set.missing.length >= boxesPerUnit) {
        throw new ReceiveError(
          "An incomplete set is a unit with some of its boxes, not none and not all of them.",
        );
      }
      const landedAt = await putAway(poItem, poItem.product.id, 1, {}, INCOMPLETE_SET_CONDITION);
      await record(item, 1, INCOMPLETE_SET_CONDITION, landedAt);
      const note = await tx.boxNote.create({
        data: {
          kind: "INCOMPLETE",
          productId: poItem.product.id,
          storeLocationId: args.storeLocationId,
          stockLocationId: await landingPlaceId(tx, args.storeLocationId, "QUARANTINE"),
          boxes: [...set.missing].sort((a, b) => a - b),
          boxesPerUnit,
          sourceType: "PurchaseOrder",
          sourceId: po.id,
          note: `Arrived on ${po.poNumber} without box ${set.missing.join(", ")}`,
          createdBy: args.actor,
        },
        select: { id: true },
      });
      incompleteNotes.push(note.id);
    }
  }

  const updatedItems = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId: args.poId },
    include: { receivingRecords: { select: { quantityReceived: true } } },
  });
  const newStatus = nativeReceiptStatus(
    updatedItems.map((ui) => ({
      ordered: Number(ui.orderedQuantity),
      received: ui.receivingRecords.reduce((sum, r) => sum + Number(r.quantityReceived), 0),
    })),
    po.status,
  );
  if (newStatus !== po.status) {
    await tx.purchaseOrder.update({
      where: { id: args.poId },
      data: { status: newStatus, updatedBy: args.actor },
    });
  }

  return { receivingRecords, newStatus, printItems, incompleteNotes };
}
