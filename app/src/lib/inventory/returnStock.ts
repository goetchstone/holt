// /app/src/lib/inventory/returnStock.ts
//
// What happens to a returned piece (ledger plan phase 8, owner direction
// 2026-10-16). A return never holds up the customer:
//
//   receive    RECEIVED: the piece comes back from the customer into the
//              store's RETURNS place (lib/inventory/places.ts) -- owned, not for
//              sale unless the store pointed its returns place at a sellable
//              one -- and the place is recorded on the return. From here the
//              return can be inspected and closed whenever the customer side is
//              done.
//   put back   from the returned-stock queue: the piece moves from the place it
//              was received into (the recorded fact, rule 60) to a sellable
//              place at that store.
//   write off  from the queue: the piece leaves the books.
//
// The queue is the returns whose piece was received and is neither put back nor
// written off. Each disposition is claimed on the return before the stock
// moves, so a double-submitted click moves it once.
//
// A return received before returns places existed has no recorded place; its
// restock adds the piece from outside the books, the old way.

import type { Prisma, Return } from "@prisma/client";
import { lockProducts, postMovement } from "./ledger";
import { isStockLocationType, LOCATION_TYPE_INFO } from "./locationTypes";
import { landingPlaceId, placeAt } from "./places";
import { toQty } from "./quantity";

type Tx = Prisma.TransactionClient;

/** The piece was already put back or written off, or never came back. */
export class ReturnDispositionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 409,
  ) {
    super(message);
    this.name = "ReturnDispositionError";
  }
}

const sourceOf = (ret: Pick<Return, "id">) => ({ type: "Return", id: ret.id }) as const;

/** RECEIVED: the piece into the store's returns place. Returns the place's id. */
export async function receiveReturnStock(
  tx: Tx,
  ret: Return,
  storeLocationId: number,
  actor: string | null,
): Promise<number | null> {
  const place = await landingPlaceId(tx, storeLocationId, "RETURNS");
  const quantity = toQty(ret.quantity);
  if (ret.productId && quantity > 0) {
    await lockProducts(tx, [ret.productId]);
    await postMovement(tx, {
      productId: ret.productId,
      quantity,
      to: { storeLocationId, stockLocationId: place, salesOrderId: null },
      reason: "RETURN",
      source: sourceOf(ret),
      actor,
    });
  }
  return place;
}

/** Claim the disposition on the return, or refuse a second one. */
async function claim(tx: Tx, ret: Return, data: Prisma.ReturnUncheckedUpdateManyInput) {
  const claimed = await tx.return.updateMany({
    where: { id: ret.id, restockedAt: null, writtenOffAt: null },
    data,
  });
  if (claimed.count === 0) {
    throw new ReturnDispositionError("This return's piece was already put back or written off.");
  }
}

/** Put the piece back at a sellable place of the given store. */
export async function putBackReturn(
  tx: Tx,
  ret: Return,
  args: { storeLocationId: number; stockLocationId?: number | null; actor: string | null },
): Promise<void> {
  const to = await placeAt(tx, {
    storeLocationId: args.storeLocationId,
    stockLocationId: args.stockLocationId,
  });
  const place = await tx.stockLocation.findUniqueOrThrow({
    where: { id: to.stockLocationId },
    select: { storeLocationId: true, locationType: true, name: true },
  });
  if (place.storeLocationId !== args.storeLocationId) {
    throw new ReturnDispositionError(`"${place.name}" is at a different store.`, 400);
  }
  if (!(
    isStockLocationType(place.locationType) && LOCATION_TYPE_INFO[place.locationType].sellable
  )) {
    throw new ReturnDispositionError(
      `"${place.name}" is not a place stock is sold from; put the piece back somewhere sellable.`,
      400,
    );
  }

  await claim(tx, ret, {
    restockedAt: new Date(),
    restockedLocationId: args.storeLocationId,
    restockedStockLocationId: to.stockLocationId,
    updatedBy: args.actor,
  });

  const quantity = toQty(ret.quantity);
  if (!ret.productId || !(quantity > 0)) return;
  await lockProducts(tx, [ret.productId]);
  if (ret.receivedStockLocationId != null && ret.receivedLocationId != null) {
    await postMovement(tx, {
      productId: ret.productId,
      quantity,
      from: {
        storeLocationId: ret.receivedLocationId,
        stockLocationId: ret.receivedStockLocationId,
        salesOrderId: null,
      },
      to,
      reason: "TRANSFER",
      source: sourceOf(ret),
      actor: args.actor,
    });
  } else {
    // Received before returns places existed: the piece was never put in the
    // books, so restocking it adds it.
    await postMovement(tx, {
      productId: ret.productId,
      quantity,
      to,
      reason: "RETURN",
      source: sourceOf(ret),
      actor: args.actor,
    });
  }
}

/** Write the piece off: it leaves the books from the place it was received into. */
export async function writeOffReturn(
  tx: Tx,
  ret: Return,
  args: { reason: string | null; actor: string | null },
): Promise<void> {
  await claim(tx, ret, {
    writtenOffAt: new Date(),
    writeOffReason: args.reason,
    updatedBy: args.actor,
  });
  const quantity = toQty(ret.quantity);
  if (!ret.productId || !(quantity > 0)) return;
  if (ret.receivedStockLocationId == null || ret.receivedLocationId == null) return;
  await lockProducts(tx, [ret.productId]);
  await postMovement(tx, {
    productId: ret.productId,
    quantity,
    from: {
      storeLocationId: ret.receivedLocationId,
      stockLocationId: ret.receivedStockLocationId,
      salesOrderId: null,
    },
    reason: "WRITE_OFF",
    source: sourceOf(ret),
    actor: args.actor,
    note: args.reason,
  });
}

/** The returns waiting in a store's queue: received, not yet put back or written off. */
export function returnedStockQueueWhere(storeLocationId?: number | null): Prisma.ReturnWhereInput {
  return {
    receivedStockLocationId: { not: null },
    restockedAt: null,
    writtenOffAt: null,
    ...(storeLocationId ? { receivedLocationId: storeLocationId } : {}),
  };
}
