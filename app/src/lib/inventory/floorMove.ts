// /app/src/lib/inventory/floorMove.ts
//
// Put away and move on the floor (ledger plan phase 18): units from one place
// to another, now, through quickMove (so a move the places' mode wants
// tracked is refused, and done as a transfer instead). Free units go first;
// then units committed to orders, each keeping its order -- a sold sofa put
// away from receiving is still that customer's in its bay.
//
// A box moved on its own ("just this box") moves no stock: units are the only
// quantity. It leaves a STRAY note where it went (lib/inventory/boxes.ts),
// which clears when it is reunited, picked with its unit, or counted absent.

import type { Prisma } from "@prisma/client";
import { drawLegs, lockProducts, type Place } from "./ledger";
import { quickMove } from "./transfers";
import { roundQty } from "./quantity";
import { clearBoxNote } from "./boxNotes";

type Tx = Prisma.TransactionClient;

export class FloorMoveError extends Error {}

async function placeStore(tx: Tx, stockLocationId: number): Promise<number> {
  const p = await tx.stockLocation.findUnique({
    where: { id: stockLocationId },
    select: { storeLocationId: true },
  });
  if (!p) throw new FloorMoveError("That place does not exist.");
  return p.storeLocationId;
}

/** Move `quantity` units of a product from one place to another; returns the legs moved. */
export async function moveUnits(
  tx: Tx,
  args: {
    productId: number;
    quantity: number;
    fromStockLocationId: number;
    toStockLocationId: number;
    actor: string | null;
    actionKey?: string | null;
  },
): Promise<{ moved: number; committedMoved: number }> {
  if (args.fromStockLocationId === args.toStockLocationId) {
    throw new FloorMoveError("It is already there.");
  }
  const fromStore = await placeStore(tx, args.fromStockLocationId);
  const toStore = await placeStore(tx, args.toStockLocationId);
  await lockProducts(tx, [args.productId]);
  const at = { storeLocationId: fromStore, stockLocationId: args.fromStockLocationId };
  const free = await drawLegs(tx, {
    productId: args.productId,
    where: { ...at, salesOrderId: null },
    quantity: args.quantity,
  });
  const committed =
    free.shortfall > 0
      ? await drawLegs(tx, {
          productId: args.productId,
          where: { ...at, salesOrderId: { not: null } },
          quantity: free.shortfall,
        })
      : { legs: [], shortfall: 0 };
  if (committed.shortfall > 0) {
    const there = roundQty(args.quantity - committed.shortfall);
    throw new FloorMoveError(`Only ${there} of that product is at the place it is moving from.`);
  }
  let committedMoved = 0;
  for (const leg of [...free.legs, ...committed.legs]) {
    const to: Place = {
      storeLocationId: toStore,
      stockLocationId: args.toStockLocationId,
      salesOrderId: leg.place.salesOrderId,
    };
    await quickMove(tx, {
      productId: args.productId,
      quantity: leg.take,
      from: leg.place,
      to,
      actor: args.actor,
      actionKey: args.actionKey,
    });
    if (leg.place.salesOrderId != null) committedMoved = roundQty(committedMoved + leg.take);
  }
  return { moved: args.quantity, committedMoved };
}

/**
 * Boxes moved without their unit. A stray note at the place they left gives
 * them up; if the place they went to holds a unit of the product, they are
 * taken as reunited with it, else a stray note says they are there.
 */
export async function moveStrayBoxes(
  tx: Tx,
  args: {
    productId: number;
    boxes: number[];
    boxesPerUnit: number;
    fromStockLocationId: number | null;
    toStockLocationId: number;
    actor: string | null;
  },
): Promise<{ reunited: boolean; noteId: number | null }> {
  if (args.boxes.length === 0) return { reunited: false, noteId: null };
  const toStore = await placeStore(tx, args.toStockLocationId);
  if (args.fromStockLocationId != null) {
    const left = await tx.boxNote.findMany({
      where: {
        kind: "STRAY",
        productId: args.productId,
        stockLocationId: args.fromStockLocationId,
        clearedAt: null,
      },
      orderBy: { id: "asc" },
    });
    let moving = [...args.boxes];
    for (const n of left) {
      const keep = n.boxes.filter((b) => {
        const i = moving.indexOf(b);
        if (i === -1) return true;
        moving = [...moving.slice(0, i), ...moving.slice(i + 1)];
        return false;
      });
      if (keep.length === 0) {
        await clearBoxNote(tx, n.id, { reason: "Moved on", actor: args.actor });
      } else if (keep.length !== n.boxes.length) {
        await tx.boxNote.update({ where: { id: n.id }, data: { boxes: keep } });
      }
    }
  }
  const unitThere = await tx.inventoryPosition.count({
    where: { productId: args.productId, stockLocationId: args.toStockLocationId },
  });
  if (unitThere > 0) return { reunited: true, noteId: null };
  const note = await tx.boxNote.create({
    data: {
      kind: "STRAY",
      productId: args.productId,
      storeLocationId: toStore,
      stockLocationId: args.toStockLocationId,
      boxes: [...args.boxes].sort((a, b) => a - b),
      boxesPerUnit: Math.max(1, args.boxesPerUnit),
      note: "Moved on its own",
      createdBy: args.actor,
    },
    select: { id: true },
  });
  return { reunited: false, noteId: note.id };
}
