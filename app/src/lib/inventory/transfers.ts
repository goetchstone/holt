// /app/src/lib/inventory/transfers.ts
//
// Moving stock between places (ledger plan phase 6). Every way of moving is a
// composition of postMovement; this file decides which movements.
//
//   ship      DRAFT -> IN_TRANSIT. The units leave their places for the source
//             store's TRANSIT place: still Holt's, counted and valued, not for
//             sale. A transfer for an order takes the order's own committed
//             units at the source first, then free ones, and every unit it
//             ships is committed to the order on the way -- the commitment
//             travels with the units, so nothing has to re-allocate on arrival.
//   receive   IN_TRANSIT, any part of what is still on its way. The units go
//             from transit to the destination place (or the destination's
//             receiving place), keeping their owner. The transfer is RECEIVED
//             once all of it has arrived.
//   cancel    The units still in transit go back to the exact places they
//             left, read from this transfer's journal legs, newest first.
//   quick     One movement A -> B, no transit. Allowed only where the two ends'
//             move mode (lib/inventory/moveModes.ts) is QUICK.
//
// Transfers shipped before the transit place existed shipped their units out
// of the books. They are received and cancelled the old way: from outside the
// books to the destination, or back to the source.

import type { InventoryTransfer, Prisma } from "@prisma/client";
import { freePositionWhere } from "./allocation";
import { drawLegs, lockProducts, postMovement, type DrawLeg, type Place } from "./ledger";
import { requiredMoveMode } from "./moveModes";
import { landingPlaceId, placeAt } from "./places";
import { QTY_EPSILON, roundQty, toQty } from "./quantity";
import { settleShortfalls } from "@/lib/reports/oversold";

type Tx = Prisma.TransactionClient;

/** The source does not hold enough of what the transfer asks to move. */
export class TransferShortError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
    readonly source: string,
  ) {
    super(`Only ${available} of the ${requested} requested are free to ship from ${source}.`);
    this.name = "TransferShortError";
  }
}

/** A receipt for more than is still on its way, or for nothing. */
export class TransferQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferQuantityError";
  }
}

/** The places' move mode does not allow a one-step move between them. */
export class MoveModeError extends Error {
  constructor() {
    super("These places need a tracked transfer: create one and receive it at the other end.");
    this.name = "MoveModeError";
  }
}

const sourceOf = (t: Pick<InventoryTransfer, "id">) =>
  ({ type: "InventoryTransfer", id: t.id }) as const;

/** Draw `quantity` from each where-clause in turn until it is met. */
async function drawInTiers(
  tx: Tx,
  productId: number,
  wheres: Prisma.InventoryPositionWhereInput[],
  quantity: number,
): Promise<{ legs: DrawLeg[]; shortfall: number }> {
  const legs: DrawLeg[] = [];
  let left = quantity;
  for (const where of wheres) {
    if (left <= QTY_EPSILON) break;
    const tier = await drawLegs(tx, { productId, where, quantity: left });
    legs.push(...tier.legs);
    left = tier.shortfall;
  }
  return { legs, shortfall: left > QTY_EPSILON ? roundQty(left) : 0 };
}

/** DRAFT -> IN_TRANSIT: the units go to the source store's transit place. */
export async function shipTransfer(tx: Tx, t: InventoryTransfer, actor: string | null) {
  const quantity = toQty(t.quantity);
  const fromStore = t.fromLocationId!;
  await lockProducts(tx, [t.productId]);
  const transit = await landingPlaceId(tx, fromStore, "TRANSIT");
  const owner = t.salesOrderId ?? null;

  // A stock location the user chose is taken at its word: its uncommitted units
  // go, whether or not it is flagged as holding customers' stock (moving that
  // stock between stores is a real task). With none chosen, only stock free to
  // sell at that store will do. An order's own units come first either way.
  const at: Prisma.InventoryPositionWhereInput = t.fromStockLocationId
    ? { storeLocationId: fromStore, stockLocationId: t.fromStockLocationId }
    : { storeLocationId: fromStore, stockLocation: { locationType: { not: "TRANSIT" } } };
  const tiers: Prisma.InventoryPositionWhereInput[] = [];
  if (owner != null) tiers.push({ AND: [at, { salesOrderId: owner }] });
  tiers.push(
    t.fromStockLocationId
      ? { AND: [at, { salesOrderId: null }] }
      : { AND: [freePositionWhere(), { storeLocationId: fromStore }] },
  );

  const { legs, shortfall } = await drawInTiers(tx, t.productId, tiers, quantity);
  if (shortfall > 0) {
    throw new TransferShortError(roundQty(quantity - shortfall), quantity, t.fromLocation);
  }
  for (const leg of legs) {
    await postMovement(tx, {
      productId: t.productId,
      quantity: leg.take,
      from: leg.place,
      to: { storeLocationId: fromStore, stockLocationId: transit, salesOrderId: owner },
      reason: "TRANSFER",
      source: sourceOf(t),
      actor,
    });
  }
}

/** True when this transfer's units went into a transit place when it shipped. */
async function shippedIntoTransit(tx: Tx, t: InventoryTransfer): Promise<boolean> {
  const leg = await tx.stockMovement.findFirst({
    where: {
      sourceType: "InventoryTransfer",
      sourceId: t.id,
      toStoreLocationId: t.fromLocationId,
      toStockLocation: { locationType: "TRANSIT" },
    },
    select: { id: true },
  });
  return leg != null;
}

/** Units of this transfer still in the source store's transit place, the order's first. */
async function drawFromTransit(tx: Tx, t: InventoryTransfer, quantity: number) {
  const transit = await landingPlaceId(tx, t.fromLocationId!, "TRANSIT");
  const at = { storeLocationId: t.fromLocationId!, stockLocationId: transit };
  const tiers: Prisma.InventoryPositionWhereInput[] = [];
  if (t.salesOrderId != null) tiers.push({ ...at, salesOrderId: t.salesOrderId });
  tiers.push({ ...at, salesOrderId: null });
  const drawn = await drawInTiers(tx, t.productId, tiers, quantity);
  if (drawn.shortfall > 0) {
    throw new TransferShortError(
      roundQty(quantity - drawn.shortfall),
      quantity,
      `${t.fromLocation}'s in-transit place`,
    );
  }
  return drawn.legs;
}

/**
 * Receive `quantity` (default: everything still on its way). Returns whether
 * the transfer has now fully arrived.
 */
export async function receiveTransfer(
  tx: Tx,
  t: InventoryTransfer,
  quantity: number | null,
  actor: string | null,
): Promise<{ complete: boolean; received: number }> {
  const remaining = roundQty(toQty(t.quantity) - toQty(t.receivedQuantity));
  const take = quantity == null ? remaining : roundQty(quantity);
  if (!(take > 0)) throw new TransferQuantityError("Receive a quantity greater than zero.");
  if (take > remaining + QTY_EPSILON) {
    throw new TransferQuantityError(`Only ${remaining} of this transfer is still on its way.`);
  }
  await lockProducts(tx, [t.productId]);
  const to = await placeAt(tx, {
    storeLocationId: t.toLocationId!,
    stockLocationId: t.toStockLocationId,
  });

  if (await shippedIntoTransit(tx, t)) {
    for (const leg of await drawFromTransit(tx, t, take)) {
      await postMovement(tx, {
        productId: t.productId,
        quantity: leg.take,
        from: leg.place,
        to: { ...to, salesOrderId: leg.place.salesOrderId },
        reason: "TRANSFER",
        source: sourceOf(t),
        actor,
      });
    }
  } else {
    // Shipped out of the books before transit places existed.
    await postMovement(tx, {
      productId: t.productId,
      quantity: take,
      to,
      reason: "TRANSFER",
      source: sourceOf(t),
      actor,
    });
  }

  // Units arriving committed to the order may cover its shortfall.
  if (t.salesOrderId != null) await settleShortfalls(tx, t.salesOrderId);

  const received = roundQty(toQty(t.receivedQuantity) + take);
  return { complete: received + QTY_EPSILON >= toQty(t.quantity), received };
}

/** IN_TRANSIT -> CANCELLED: what is still on its way goes back where it left. */
export async function cancelTransfer(tx: Tx, t: InventoryTransfer, actor: string | null) {
  let left = roundQty(toQty(t.quantity) - toQty(t.receivedQuantity));
  if (!(left > QTY_EPSILON)) return;
  await lockProducts(tx, [t.productId]);

  if (!(await shippedIntoTransit(tx, t))) {
    await postMovement(tx, {
      productId: t.productId,
      quantity: left,
      to: await placeAt(tx, {
        storeLocationId: t.fromLocationId!,
        stockLocationId: t.fromStockLocationId,
      }),
      reason: "TRANSFER",
      source: sourceOf(t),
      actor,
    });
    return;
  }

  // The legs that took units into transit, newest first: each place gets back
  // up to what it gave, until everything still on its way is home.
  const shipLegs = await tx.stockMovement.findMany({
    where: {
      sourceType: "InventoryTransfer",
      sourceId: t.id,
      fromStoreLocationId: { not: null },
      toStoreLocationId: t.fromLocationId,
      toStockLocation: { locationType: "TRANSIT" },
    },
    orderBy: { id: "desc" },
  });
  for (const ship of shipLegs) {
    if (!(left > QTY_EPSILON)) break;
    const back = roundQty(Math.min(toQty(ship.quantity), left));
    for (const leg of await drawFromTransit(tx, t, back)) {
      const home: Place = {
        storeLocationId: ship.fromStoreLocationId!,
        stockLocationId: ship.fromStockLocationId!,
        salesOrderId: leg.place.salesOrderId,
      };
      await postMovement(tx, {
        productId: t.productId,
        quantity: leg.take,
        from: leg.place,
        to: home,
        reason: "TRANSFER",
        source: sourceOf(t),
        actor,
      });
    }
    left = roundQty(left - back);
  }
}

/**
 * One movement from one place to another, now. Refused with MoveModeError when
 * the places' move mode needs a tracked transfer.
 */
export async function quickMove(
  tx: Tx,
  args: {
    productId: number;
    quantity: number;
    from: Place;
    to: Place;
    actor: string | null;
    source?: { type: "InventoryTransfer"; id: number };
    actionKey?: string | null;
  },
) {
  if (
    (await requiredMoveMode(tx, args.from.stockLocationId, args.to.stockLocationId)) !== "QUICK"
  ) {
    throw new MoveModeError();
  }
  await postMovement(tx, {
    productId: args.productId,
    quantity: args.quantity,
    from: args.from,
    to: args.to,
    reason: "TRANSFER",
    source: args.source ?? null,
    actor: args.actor,
    actionKey: args.actionKey,
  });
}

/** A transfer on its way to a screen: its quantities as numbers, not Decimal strings. */
export function transferForClient<
  T extends { quantity: Prisma.Decimal; receivedQuantity: Prisma.Decimal },
>(t: T) {
  return { ...t, quantity: toQty(t.quantity), receivedQuantity: toQty(t.receivedQuantity) };
}
