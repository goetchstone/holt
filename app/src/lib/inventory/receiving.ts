// /app/src/lib/inventory/receiving.ts
//
// Goods from a supplier into stock (ledger plan phase 7).
//
//   - Received Damaged or Wrong Item: into the store's quarantine place, owned
//     and not for sale (lib/purchasing/receiptConditions.ts).
//   - Otherwise into the place chosen, or the store's receiving place.
//   - A PO line raised for an order -- its line on an open order, or a PO
//     raised for the whole order -- arrives committed to that order, up to what
//     the order still needs of the product. Anything beyond that arrives free.
//     It used to arrive free and wait for somebody to re-allocate it, which
//     nothing did.

import type { Prisma } from "@prisma/client";
import { isQuarantinedCondition } from "@/lib/purchasing/receiptConditions";
import { postMovement } from "./ledger";
import { landingPlaceId, placeAt } from "./places";
import { roundQty, toQty } from "./quantity";
import { settleShortfalls } from "@/lib/reports/oversold";

type Tx = Prisma.TransactionClient;

/** The open order a PO line was raised for, if any. */
export async function receiptOrderId(
  tx: Tx,
  po: { salesOrderId: number | null },
  poItem: { orderLineItemId: number | null },
): Promise<number | null> {
  if (poItem.orderLineItemId != null) {
    const line = await tx.orderLineItem.findUnique({
      where: { id: poItem.orderLineItemId },
      select: { lineItemStatus: true, salesOrder: { select: { id: true, status: true } } },
    });
    if (line?.lineItemStatus === "ACTIVE" && line.salesOrder.status === "ORDER") {
      return line.salesOrder.id;
    }
    return null;
  }
  if (po.salesOrderId != null) {
    const order = await tx.salesOrder.findUnique({
      where: { id: po.salesOrderId },
      select: { status: true },
    });
    if (order?.status === "ORDER") return po.salesOrderId;
  }
  return null;
}

/** What an order still needs committed of a product: its active lines less what it holds. */
async function stillNeeded(tx: Tx, orderId: number, productId: number): Promise<number> {
  const [lines, held] = await Promise.all([
    tx.orderLineItem.aggregate({
      where: { salesOrderId: orderId, productId, lineItemStatus: "ACTIVE" },
      _sum: { orderedQuantity: true },
    }),
    tx.inventoryPosition.aggregate({
      where: { salesOrderId: orderId, productId },
      _sum: { quantity: true },
    }),
  ]);
  return Math.max(0, roundQty(toQty(lines._sum.orderedQuantity) - toQty(held._sum.quantity)));
}

/** Post one receipt line into stock. Returns the order it was committed to, if any. */
export async function receiveIntoStock(
  tx: Tx,
  args: {
    po: { id: number; salesOrderId: number | null };
    poItem: { orderLineItemId: number | null };
    productId: number;
    quantity: number;
    storeLocationId: number;
    stockLocationId?: number | null;
    condition?: string | null;
    actor: string | null;
  },
): Promise<{ committedTo: number | null }> {
  const source = { type: "PurchaseOrder", id: args.po.id } as const;
  const base = { productId: args.productId, reason: "RECEIVE" as const, source, actor: args.actor };

  if (isQuarantinedCondition(args.condition)) {
    const quarantine = await landingPlaceId(tx, args.storeLocationId, "QUARANTINE");
    await postMovement(tx, {
      ...base,
      quantity: args.quantity,
      to: {
        storeLocationId: args.storeLocationId,
        stockLocationId: quarantine,
        salesOrderId: null,
      },
      note: `Received ${args.condition}`,
    });
    return { committedTo: null };
  }

  const place = await placeAt(tx, {
    storeLocationId: args.storeLocationId,
    stockLocationId: args.stockLocationId,
  });
  const orderId = await receiptOrderId(tx, args.po, args.poItem);
  const committed =
    orderId == null ? 0 : Math.min(args.quantity, await stillNeeded(tx, orderId, args.productId));
  if (committed > 0) {
    await postMovement(tx, {
      ...base,
      quantity: committed,
      to: { ...place, salesOrderId: orderId },
    });
  }
  const free = roundQty(args.quantity - committed);
  if (free > 0) await postMovement(tx, { ...base, quantity: free, to: place });
  if (committed > 0 && orderId != null) await settleShortfalls(tx, orderId);
  return { committedTo: committed > 0 ? orderId : null };
}
