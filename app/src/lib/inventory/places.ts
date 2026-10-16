// /app/src/lib/inventory/places.ts
//
// Every unit of stock is somewhere. When a caller knows the store but not the
// place in it -- a receipt with no destination chosen, a transfer to "the
// store", an admin entry with no stock location -- the units go to the store's
// receiving place: arrived, not yet put away, and still sellable.
//
// The receiving place is StoreLocation.defaultReceivingStockLocationId, set in
// Setup > Stores. A store that has none gets one the first time it is needed (a
// place coded RECEIVING, of type RECEIVING), and the pointer is set so the next
// write finds it. Creating it is a product default, not a guess about a
// deployment: every store that takes delivery has somewhere goods land, and an
// admin can point the setting at a different place at any time.

import type { Prisma } from "@prisma/client";
import { withStockTx, type Place, type PrismaTx } from "./ledger";

/** The code and name of a receiving place Holt creates for a store that has none. */
export const RECEIVING_PLACE_CODE = "RECEIVING";
const RECEIVING_PLACE_NAME = "Receiving";

/**
 * Advisory-lock space for creating a store's system places, separate from the
 * stock lock space in ledger.ts, so two sessions that both find a store with no
 * receiving place create one place between them, not two.
 */
const PLACE_SETUP_LOCK_SPACE = 5_461_068;

/** The store's receiving place, created and recorded the first time it is needed. */
export async function receivingStockLocationId(
  db: PrismaTx,
  storeLocationId: number,
): Promise<number> {
  return withStockTx(db, async (tx) => {
    const current = await readPointer(tx, storeLocationId);
    if (current != null) return current;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACE_SETUP_LOCK_SPACE}::int, ${storeLocationId}::int)`;
    const afterLock = await readPointer(tx, storeLocationId);
    if (afterLock != null) return afterLock;

    // A store may already have a place coded RECEIVING that nobody pointed the
    // setting at; that is the place, not a second one beside it. The compound
    // key has no nullable column, so this upsert can match (rule 64).
    const place = await tx.stockLocation.upsert({
      where: { storeLocationId_code: { storeLocationId, code: RECEIVING_PLACE_CODE } },
      create: {
        storeLocationId,
        code: RECEIVING_PLACE_CODE,
        name: RECEIVING_PLACE_NAME,
        locationType: "RECEIVING",
        createdBy: "system",
      },
      update: {},
      select: { id: true },
    });
    await tx.storeLocation.update({
      where: { id: storeLocationId },
      data: { defaultReceivingStockLocationId: place.id },
    });
    return place.id;
  });
}

async function readPointer(tx: Prisma.TransactionClient, storeLocationId: number) {
  const store = await tx.storeLocation.findUnique({
    where: { id: storeLocationId },
    select: { defaultReceivingStockLocationId: true },
  });
  if (!store) throw new Error(`Store ${storeLocationId} does not exist.`);
  return store.defaultReceivingStockLocationId;
}

/**
 * A place at `storeLocationId`: the stock location given, or the store's
 * receiving place when none is. For callers whose input lets the place be left
 * out.
 */
export async function placeAt(
  db: PrismaTx,
  args: {
    storeLocationId: number;
    stockLocationId?: number | null;
    salesOrderId?: number | null;
  },
): Promise<Place> {
  return {
    storeLocationId: args.storeLocationId,
    stockLocationId:
      args.stockLocationId ?? (await receivingStockLocationId(db, args.storeLocationId)),
    salesOrderId: args.salesOrderId ?? null,
  };
}
