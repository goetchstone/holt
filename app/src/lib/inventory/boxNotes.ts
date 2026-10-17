// /app/src/lib/inventory/boxNotes.ts
//
// Box notes in the database (ledger plan phases 16 and 18; the rules are pure
// in boxes.ts). A note is never a quantity: the units are in InventoryPosition
// like everything else, and a note only says which boxes are missing from a
// unit (INCOMPLETE) or sit apart from it (STRAY).

import type { Prisma } from "@prisma/client";
import { postMovement } from "./ledger";
import { placeAt } from "./places";
import { receiptOrderId, stillNeeded } from "./receiving";
import { settleShortfalls } from "@/lib/reports/oversold";
import { BoxError, stillMissing } from "./boxes";

type Tx = Prisma.TransactionClient;

/** Open box notes, newest first, for a product (and a store, when given). */
export function openBoxNotes(
  tx: Tx,
  where: { productId?: number; storeLocationId?: number; kind?: "INCOMPLETE" | "STRAY" },
) {
  return tx.boxNote.findMany({
    where: { ...where, clearedAt: null },
    orderBy: { id: "desc" },
    select: {
      id: true,
      kind: true,
      productId: true,
      storeLocationId: true,
      stockLocationId: true,
      boxes: true,
      boxesPerUnit: true,
      sourceType: true,
      sourceId: true,
      note: true,
      created: true,
    },
  });
}

export async function clearBoxNote(
  tx: Tx,
  noteId: number,
  args: { reason: string; actor: string | null },
): Promise<void> {
  await tx.boxNote.updateMany({
    where: { id: noteId, clearedAt: null },
    data: { clearedAt: new Date(), clearedBy: args.actor, clearReason: args.reason },
  });
}

/**
 * Boxes that arrived for a unit waiting in quarantine. When the last missing
 * box comes, the unit is whole: it moves out of quarantine into stock (the
 * place given, or the store's receiving place), committed to the order its PO
 * line was raised for if that order still needs it, and the note clears.
 */
export async function addBoxesToIncompleteSet(
  tx: Tx,
  args: {
    noteId: number;
    boxes: number[];
    storeLocationId: number;
    toStockLocationId?: number | null;
    actor: string | null;
    actionKey?: string | null;
  },
): Promise<{ completed: boolean; stillMissing: number[] }> {
  const note = await tx.boxNote.findFirst({
    where: {
      id: args.noteId,
      kind: "INCOMPLETE",
      clearedAt: null,
      storeLocationId: args.storeLocationId,
    },
  });
  if (!note) throw new BoxError("That incomplete set is not waiting at this store.");
  const left = stillMissing(note.boxes, args.boxes);
  if (left.length > 0) {
    await tx.boxNote.update({ where: { id: note.id }, data: { boxes: left } });
    return { completed: false, stillMissing: left };
  }

  const to = await placeAt(tx, {
    storeLocationId: args.storeLocationId,
    stockLocationId: args.toStockLocationId,
  });
  const source =
    note.sourceType === "PurchaseOrder" && note.sourceId != null
      ? ({ type: "PurchaseOrder", id: note.sourceId } as const)
      : null;
  await postMovement(tx, {
    productId: note.productId,
    quantity: 1,
    from: {
      storeLocationId: note.storeLocationId,
      stockLocationId: note.stockLocationId,
      salesOrderId: null,
    },
    to,
    reason: "TRANSFER",
    source,
    actor: args.actor,
    note: "Last box arrived: the set is whole",
    actionKey: args.actionKey,
  });

  // Committed where an ordinary receipt of it would have been.
  if (source) {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: source.id },
      select: {
        id: true,
        salesOrderId: true,
        lineItems: {
          where: { productId: note.productId },
          select: { orderLineItemId: true },
          take: 1,
        },
      },
    });
    const orderId = po?.lineItems[0] ? await receiptOrderId(tx, po, po.lineItems[0]) : null;
    if (orderId != null && (await stillNeeded(tx, orderId, note.productId)) > 0) {
      await postMovement(tx, {
        productId: note.productId,
        quantity: 1,
        from: to,
        to: { ...to, salesOrderId: orderId },
        reason: "ALLOCATE",
        source,
        actor: args.actor,
        actionKey: args.actionKey,
      });
      await settleShortfalls(tx, orderId);
    }
  }

  await clearBoxNote(tx, note.id, { reason: "Last box arrived", actor: args.actor });
  return { completed: true, stillMissing: [] };
}
