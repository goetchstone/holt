// /app/src/lib/inventory/setAside.ts
//
// Stock set aside as damaged (GAP-16). "Damaged" used to exist only at a PO
// receipt (receiving's Damaged condition) and on a customer return, so a piece
// that was already in stock -- scuffed on the floor, dropped in the warehouse,
// found broken on a count -- could not be marked as anything but sellable.
//
//   setAsideDamaged    units at a place go to the store's QUARANTINE place
//                      (lib/inventory/places.ts), free, with what is wrong. Owned
//                      and counted, never sold or drawn by an order. Units an
//                      order had are taken from it, and the order is resynced:
//                      it draws another unit, or records a shortfall.
//   putBackSetAside    repaired, or fine after all: back to a sellable place at
//                      the same store, still whoever's they were.
//   writeOffSetAside   beyond saving: the units leave the books (WRITE_OFF).
//
//   setAsideStock      the list: everything in a QUARANTINE place, whatever put
//                      it there (receiving's Damaged and Wrong Item, an
//                      incomplete set, or setAsideDamaged).
//
// Two kinds of quarantined stock have their own way out and are refused here:
//   - a store's returns place, when a store points it at a quarantine place:
//     each piece there belongs to a return, and the returned-stock queue
//     (lib/inventory/returnStock.ts) puts it back or writes it off;
//   - an incomplete set of boxes (an open INCOMPLETE BoxNote): it is finished by
//     receiving its missing boxes, or counted absent (lib/inventory/boxNotes.ts).
//
// Every write is a postMovement (lib/inventory/ledger.ts) on the row's own
// place, under the product's lock, so the journal says what happened and why.

import type { Prisma, PrismaClient } from "@prisma/client";
import { lockProducts, placeOf, postMovement } from "./ledger";
import { isStockLocationType, LOCATION_TYPE_INFO } from "./locationTypes";
import { landingPlaceId, placeAt } from "./places";
import { roundQty, toQty } from "./quantity";
import { resyncOrderAllocation } from "./orderInventorySync";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** What the caller got wrong: the route answers with this status and message. */
export class SetAsideError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "SetAsideError";
  }
}

/** Longest "what is wrong" kept on the journal. */
export const SET_ASIDE_NOTE_MAX = 500;

function cleanNote(note: unknown, required: string): string {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new SetAsideError(required, 400);
  if (text.length > SET_ASIDE_NOTE_MAX) {
    throw new SetAsideError(`Keep it under ${SET_ASIDE_NOTE_MAX} characters.`, 400);
  }
  return text;
}

/** Read the row's product, lock it, re-read the row under the lock. */
async function lockedRow(tx: Tx, positionId: number) {
  const seen = await tx.inventoryPosition.findUnique({
    where: { id: positionId },
    select: { productId: true },
  });
  if (!seen) throw new SetAsideError("That stock is no longer there.", 404);
  await lockProducts(tx, [seen.productId]);
  const row = await tx.inventoryPosition.findUnique({
    where: { id: positionId },
    include: { stockLocation: { select: { name: true, locationType: true } } },
  });
  if (!row) throw new SetAsideError("That stock is no longer there.", 404);
  return row;
}

function unitsFrom(row: { quantity: Prisma.Decimal }, quantity: unknown): number {
  const asked = typeof quantity === "number" ? roundQty(quantity) : Number.NaN;
  const there = toQty(row.quantity);
  if (!(asked > 0)) throw new SetAsideError("Say how many: more than 0.", 400);
  if (asked > there) {
    throw new SetAsideError(`Only ${there} ${there === 1 ? "is" : "are"} there.`, 400);
  }
  return asked;
}

/** A store's returns place, which the returned-stock queue looks after. */
async function returnsPlaceIds(db: Db): Promise<number[]> {
  const stores = await db.storeLocation.findMany({
    where: { returnsStockLocationId: { not: null } },
    select: { returnsStockLocationId: true },
  });
  return stores.map((s) => s.returnsStockLocationId as number);
}

/** The row is quarantined stock this module may move: not a return, not an incomplete set. */
async function assertSetAside(tx: Tx, row: Awaited<ReturnType<typeof lockedRow>>): Promise<void> {
  if (row.stockLocation.locationType !== "QUARANTINE") {
    throw new SetAsideError("That stock isn't set aside.", 409);
  }
  if ((await returnsPlaceIds(tx)).includes(row.stockLocationId)) {
    throw new SetAsideError(
      "This is a store's returns place: put the piece back or write it off from Returned stock.",
      409,
    );
  }
  const incomplete = await tx.boxNote.count({
    where: {
      productId: row.productId,
      stockLocationId: row.stockLocationId,
      kind: "INCOMPLETE",
      clearedAt: null,
    },
  });
  if (incomplete > 0) {
    throw new SetAsideError(
      "An incomplete set: receive its missing boxes on the handheld, or count it absent.",
      409,
    );
  }
}

/** Units an order had are gone from it: it draws again, or records a shortfall. */
async function resyncOwner(tx: Tx, salesOrderId: number | null): Promise<void> {
  if (salesOrderId == null) return;
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { storeLocation: true },
  });
  if (order) await resyncOrderAllocation(salesOrderId, order.storeLocation, tx);
}

/**
 * Set units aside as damaged: from their place into the store's quarantine
 * place, as free stock, with what is wrong on the journal. Returns where they
 * went.
 */
export async function setAsideDamaged(
  tx: Tx,
  args: { positionId: number; quantity: unknown; note: unknown; actor: string | null },
): Promise<{ stockLocationId: number }> {
  const row = await lockedRow(tx, args.positionId);
  const quantity = unitsFrom(row, args.quantity);
  const note = cleanNote(args.note, "Say what is wrong with it.");
  if (row.stockLocation.locationType === "QUARANTINE") {
    throw new SetAsideError("That stock is already set aside.", 409);
  }
  const quarantine = await landingPlaceId(tx, row.storeLocationId, "QUARANTINE");
  await postMovement(tx, {
    productId: row.productId,
    quantity,
    from: placeOf(row),
    to: { storeLocationId: row.storeLocationId, stockLocationId: quarantine, salesOrderId: null },
    reason: "DAMAGE",
    actor: args.actor,
    note: `Damaged: ${note}`,
  });
  await resyncOwner(tx, row.salesOrderId);
  return { stockLocationId: quarantine };
}

/** Back on sale: from quarantine to a sellable place at the same store, still whoever's. */
export async function putBackSetAside(
  tx: Tx,
  args: { positionId: number; quantity: unknown; stockLocationId: unknown; actor: string | null },
): Promise<void> {
  const row = await lockedRow(tx, args.positionId);
  const quantity = unitsFrom(row, args.quantity);
  await assertSetAside(tx, row);
  if (typeof args.stockLocationId !== "number") {
    throw new SetAsideError("Say which place it goes back to.", 400);
  }
  const to = await placeAt(tx, {
    storeLocationId: row.storeLocationId,
    stockLocationId: args.stockLocationId,
    salesOrderId: row.salesOrderId,
  });
  const place = await tx.stockLocation.findUnique({
    where: { id: to.stockLocationId },
    select: { name: true, storeLocationId: true, locationType: true },
  });
  if (!place) throw new SetAsideError("That place doesn't exist.", 400);
  if (place.storeLocationId !== row.storeLocationId) {
    throw new SetAsideError(`"${place.name}" is at a different store.`, 400);
  }
  if (!(
    isStockLocationType(place.locationType) && LOCATION_TYPE_INFO[place.locationType].sellable
  )) {
    throw new SetAsideError(
      `"${place.name}" is not a place stock is sold from; put it back somewhere sellable.`,
      400,
    );
  }
  await postMovement(tx, {
    productId: row.productId,
    quantity,
    from: placeOf(row),
    to,
    reason: "TRANSFER",
    actor: args.actor,
    note: "Back to stock from quarantine",
  });
}

/** Beyond saving: the units leave the books from quarantine, with why. */
export async function writeOffSetAside(
  tx: Tx,
  args: { positionId: number; quantity: unknown; note: unknown; actor: string | null },
): Promise<void> {
  const row = await lockedRow(tx, args.positionId);
  const quantity = unitsFrom(row, args.quantity);
  const note = cleanNote(args.note, "Say why it is written off.");
  await assertSetAside(tx, row);
  await postMovement(tx, {
    productId: row.productId,
    quantity,
    from: placeOf(row),
    reason: "WRITE_OFF",
    actor: args.actor,
    note,
  });
  await resyncOwner(tx, row.salesOrderId);
}

export interface SetAsideRow {
  positionId: number;
  productId: number;
  productNumber: string;
  productName: string;
  storeLocationId: number;
  storeName: string;
  stockLocationId: number;
  placeName: string;
  quantity: number;
  /** The order these units are committed to, if any. */
  orderno: string | null;
  /** What the last movement into the place said (receiving's condition, the damage). */
  note: string | null;
  /** An incomplete set: finished by its missing boxes, not here. */
  incompleteSet: boolean;
  since: Date;
}

/** Everything set aside in quarantine, oldest first; a store's returns place is left out. */
export async function setAsideStock(
  db: Db,
  opts: { storeLocationId?: number | null } = {},
): Promise<SetAsideRow[]> {
  const returnsPlaces = await returnsPlaceIds(db);
  const rows = await db.inventoryPosition.findMany({
    where: {
      stockLocation: { locationType: "QUARANTINE" },
      stockLocationId: { notIn: returnsPlaces },
      ...(opts.storeLocationId ? { storeLocationId: opts.storeLocationId } : {}),
    },
    include: {
      product: { select: { productNumber: true, name: true } },
      storeLocation: { select: { name: true } },
      stockLocation: { select: { name: true } },
      salesOrder: { select: { orderno: true } },
    },
    orderBy: [{ updated: "asc" }, { id: "asc" }],
  });
  const incomplete = await db.boxNote.findMany({
    where: {
      kind: "INCOMPLETE",
      clearedAt: null,
      stockLocationId: { in: [...new Set(rows.map((r) => r.stockLocationId))] },
    },
    select: { productId: true, stockLocationId: true },
  });
  const incompleteKey = new Set(incomplete.map((n) => `${n.productId}|${n.stockLocationId}`));
  return rows.map((r) => ({
    positionId: r.id,
    productId: r.productId,
    productNumber: r.product.productNumber,
    productName: r.product.name,
    storeLocationId: r.storeLocationId,
    storeName: r.storeLocation.name,
    stockLocationId: r.stockLocationId,
    placeName: r.stockLocation.name,
    quantity: toQty(r.quantity),
    orderno: r.salesOrder?.orderno ?? null,
    note: r.notes,
    incompleteSet: incompleteKey.has(`${r.productId}|${r.stockLocationId}`),
    since: r.updated ?? r.created,
  }));
}
