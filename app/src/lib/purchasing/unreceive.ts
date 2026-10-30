// /app/src/lib/purchasing/unreceive.ts
//
// GAP-02: take a receipt back -- goods booked in that never came, or came
// short. In the caller's transaction:
//
//   - The units leave stock from the place they landed (the receipt records it,
//     lib/inventory/receiving.ts), free units first, then any committed there
//     to the order the PO line was raised for. Units that have since moved or
//     sold are not there to take: the correction is refused and says how many
//     are, rather than taking stock from somewhere else.
//   - They leave the product's average landed cost at the cost they came in at
//     (lib/purchasing/landedCost.ts).
//   - The receipt shrinks, or goes when nothing is left of it, and the PO's
//     status is worked out again (lib/purchasing/receiptStatus.ts).
//
// A receipt the POS import wrote is not taken back here: its stock came in
// through the import, and a count corrects it.

import type { Prisma } from "@prisma/client";
import { lockProducts, placeWhere, postMovement, type Place } from "@/lib/inventory/ledger";
import { landingPlaceId } from "@/lib/inventory/places";
import { parseQty } from "@/lib/inventory/qtyInput";
import { roundQty, toQty, QTY_EPSILON } from "@/lib/inventory/quantity";
import { receiptOrderId } from "@/lib/inventory/receiving";
import { isQuarantinedCondition } from "@/lib/purchasing/receiptConditions";
import { correctedReceiptStatus } from "@/lib/purchasing/receiptStatus";
import { averageOutReceipt } from "@/lib/purchasing/landedCost";

type Tx = Prisma.TransactionClient;

export class UnreceiveError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "UnreceiveError";
  }
}

async function heldAt(tx: Tx, productId: number, place: Place): Promise<number> {
  const sum = await tx.inventoryPosition.aggregate({
    where: placeWhere(productId, place),
    _sum: { quantity: true },
  });
  return toQty(sum._sum.quantity);
}

/** Where a receipt's units landed: recorded since GAP-02, worked out before it. */
async function landedPlace(
  tx: Tx,
  record: {
    destinationLocationId: number | null;
    destinationStockLocationId: number | null;
    condition: string | null;
  },
): Promise<{ storeLocationId: number; stockLocationId: number }> {
  if (record.destinationLocationId === null) {
    throw new UnreceiveError(
      "This receipt doesn't say where it landed; correct its stock with a count.",
      409,
    );
  }
  const stockLocationId =
    record.destinationStockLocationId ??
    (await landingPlaceId(
      tx,
      record.destinationLocationId,
      isQuarantinedCondition(record.condition) ? "QUARANTINE" : "RECEIVING",
    ));
  return { storeLocationId: record.destinationLocationId, stockLocationId };
}

type ReceiptToCorrect = NonNullable<Awaited<ReturnType<typeof loadReceipt>>>;

async function loadReceipt(tx: Tx, receivingRecordId: number) {
  return tx.receivingRecord.findUnique({
    where: { id: receivingRecordId },
    include: {
      purchaseOrder: { select: { id: true, poNumber: true, status: true, salesOrderId: true } },
      purchaseOrderItem: { select: { orderLineItemId: true, productId: true } },
    },
  });
}

/** Take `quantity` of a receipt's units out of stock and out of the average. */
async function takeOutOfStock(
  tx: Tx,
  record: ReceiptToCorrect,
  productId: number,
  quantity: number,
  actor: string | null,
): Promise<void> {
  await lockProducts(tx, [productId]);
  const at = await landedPlace(tx, record);
  const orderId = await receiptOrderId(tx, record.purchaseOrder, record.purchaseOrderItem);
  const freePlace: Place = { ...at, salesOrderId: null };
  const orderPlace: Place | null = orderId === null ? null : { ...at, salesOrderId: orderId };
  const free = await heldAt(tx, productId, freePlace);
  const committed = orderPlace ? await heldAt(tx, productId, orderPlace) : 0;
  if (free + committed < quantity - QTY_EPSILON) {
    const place = await tx.stockLocation.findUnique({
      where: { id: at.stockLocationId },
      select: { name: true },
    });
    throw new UnreceiveError(
      `Only ${roundQty(free + committed)} of these are still at ${place?.name ?? "the place they landed"}, ` +
        "where they were received; the rest have moved or sold. Correct them with a count.",
      409,
    );
  }

  if (record.landedUnitCost != null) {
    await averageOutReceipt(tx, { productId, quantity, unitCost: Number(record.landedUnitCost) });
  }
  const fromFree = Math.min(free, quantity);
  const fromOrder = roundQty(quantity - fromFree);
  const base = {
    productId,
    reason: "UNRECEIVE" as const,
    source: { type: "PurchaseOrder", id: record.purchaseOrder.id } as const,
    actor,
    note: `Receipt on ${record.purchaseOrder.poNumber} corrected`,
  };
  if (fromFree > 0) await postMovement(tx, { ...base, quantity: fromFree, from: freePlace });
  if (fromOrder > 0 && orderPlace) {
    await postMovement(tx, { ...base, quantity: fromOrder, from: orderPlace });
  }
}

/** Work the PO's status out again from what its lines still have received. */
async function restatus(
  tx: Tx,
  po: ReceiptToCorrect["purchaseOrder"],
  actor: string | null,
): Promise<string> {
  const lines = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId: po.id },
    include: { receivingRecords: { select: { quantityReceived: true } } },
  });
  const newStatus = correctedReceiptStatus(
    lines.map((l) => ({
      ordered: toQty(l.orderedQuantity),
      received: l.receivingRecords.reduce((sum, r) => sum + toQty(r.quantityReceived), 0),
    })),
    po.status,
  );
  if (newStatus !== po.status) {
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status: newStatus, updatedBy: actor },
    });
  }
  return newStatus;
}

export async function unreceive(
  tx: Tx,
  args: { receivingRecordId: number; quantity: unknown; actor: string | null },
): Promise<{ remaining: number; newStatus: string }> {
  const record = await loadReceipt(tx, args.receivingRecordId);
  if (!record) throw new UnreceiveError("Receipt not found.", 404);
  if (record.externalGipNo != null || record.externalPorNo != null) {
    throw new UnreceiveError(
      "This receipt came in through the import; correct its stock with a count.",
      409,
    );
  }
  const had = toQty(record.quantityReceived);
  const quantity = parseQty(args.quantity);
  if (quantity == null || quantity > had + QTY_EPSILON) {
    throw new UnreceiveError(`Take back more than 0 and no more than the ${had} received.`);
  }

  const productId = record.purchaseOrderItem.productId;
  if (productId !== null) await takeOutOfStock(tx, record, productId, quantity, args.actor);

  const remaining = roundQty(had - quantity);
  if (remaining <= QTY_EPSILON) {
    await tx.receivingRecord.delete({ where: { id: record.id } });
  } else {
    await tx.receivingRecord.update({
      where: { id: record.id },
      data: { quantityReceived: remaining },
    });
  }
  return {
    remaining: Math.max(0, remaining),
    newStatus: await restatus(tx, record.purchaseOrder, args.actor),
  };
}
