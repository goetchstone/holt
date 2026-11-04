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
//   send      The handheld's transfer (GAP-19): units leave a scanned place
//             now, made into transfers already on their way (sendFromPlace).
//   arrivals  The handheld's receipt: what was scanned at the destination
//             store is received against the transfers on their way to it
//             (receiveArrivals).
//
// Every receipt, desk or handheld, goes through claimAndReceive (rule 42).
//
// Transfers shipped before the transit place existed shipped their units out
// of the books. They are received and cancelled the old way: from outside the
// books to the destination, or back to the source.

import type { InventoryTransfer, Prisma } from "@prisma/client";
import { freePositionWhere } from "./allocation";
import { drawLegs, lockProducts, postMovement, type DrawLeg, type Place } from "./ledger";
import { LOCATION_TYPE_INFO, isStockLocationType } from "./locationTypes";
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

/** Another request changed this transfer after it was read. */
export class TransferRaceError extends Error {
  constructor() {
    super("This transfer was just changed by someone else. Refresh to see its current status.");
    this.name = "TransferRaceError";
  }
}

/** A place or store a handheld transfer names that it can't use. */
export class TransferPlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferPlaceError";
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
export async function shipTransfer(
  tx: Tx,
  t: InventoryTransfer,
  actor: string | null,
  actionKey: string | null = null,
) {
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
      actionKey,
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

export interface ReceiveOptions {
  /** Where the units were put, when someone scanned it; else the transfer's own place. */
  toStockLocationId?: number | null;
  actionKey?: string | null;
}

/**
 * Receive `quantity` (default: everything still on its way). Returns whether
 * the transfer has now fully arrived. Not called directly: claimAndReceive
 * claims the transfer first.
 */
async function receiveTransfer(
  tx: Tx,
  t: InventoryTransfer,
  quantity: number | null,
  actor: string | null,
  opts: ReceiveOptions,
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
    stockLocationId: opts.toStockLocationId ?? t.toStockLocationId,
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
        actionKey: opts.actionKey,
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
      actionKey: opts.actionKey,
    });
  }

  // Units arriving committed to the order may cover its shortfall.
  if (t.salesOrderId != null) await settleShortfalls(tx, t.salesOrderId);

  const received = roundQty(toQty(t.receivedQuantity) + take);
  return { complete: received + QTY_EPSILON >= toQty(t.quantity), received };
}

/**
 * Receive part or all of an IN_TRANSIT transfer as `t` was read. The claim
 * matches the status and received quantity read, so a request that read the
 * transfer before another changed it moves nothing (TransferRaceError): a
 * double-clicked "Receive" would otherwise take the units twice. The desk's
 * status change and the handheld's receipt both come through here.
 */
export async function claimAndReceive(
  tx: Tx,
  t: InventoryTransfer,
  quantity: number | null,
  actor: string | null,
  opts: ReceiveOptions = {},
): Promise<{ complete: boolean; received: number }> {
  if (t.status !== "IN_TRANSIT") {
    throw new TransferQuantityError("Only a transfer on its way can be received.");
  }
  const remaining = roundQty(toQty(t.quantity) - toQty(t.receivedQuantity));
  const take = quantity == null ? remaining : roundQty(quantity);
  const willComplete = take + QTY_EPSILON >= remaining;
  const claimed = await tx.inventoryTransfer.updateMany({
    where: { id: t.id, status: t.status, receivedQuantity: t.receivedQuantity },
    data: {
      receivedQuantity: roundQty(Math.min(toQty(t.quantity), toQty(t.receivedQuantity) + take)),
      ...(willComplete
        ? { status: "RECEIVED", receivedAt: new Date(), receivedByUserId: actor }
        : {}),
    },
  });
  if (claimed.count === 0) throw new TransferRaceError();
  return receiveTransfer(tx, t, take, actor, opts);
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

/**
 * A place a handheld transfer leaves from or is put away in: one that holds
 * stock, and not an in-transit place, whose units belong to a transfer or a
 * run's truck.
 */
async function handheldPlace(tx: Tx, id: number) {
  const place = await tx.stockLocation.findUnique({
    where: { id },
    select: { id: true, code: true, name: true, storeLocationId: true, locationType: true },
  });
  if (!place) throw new TransferPlaceError("That place doesn't exist.");
  if (
    isStockLocationType(place.locationType) &&
    !LOCATION_TYPE_INFO[place.locationType].holdsStock
  ) {
    throw new TransferPlaceError(`${place.name} groups places: scan one inside it.`);
  }
  if (place.locationType === "TRANSIT") {
    throw new TransferPlaceError(
      `${place.name} is an in-transit place: scan a place in the store.`,
    );
  }
  return place;
}

export interface SendArgs {
  items: { productId: number; quantity: number }[];
  fromStockLocationId: number;
  toLocationId: number;
  /** A place at the destination store; null for its receiving place. */
  toStockLocationId: number | null;
  requestedByUserId: string;
  actor: string | null;
  actionKey?: string | null;
}

export interface SentTransfer {
  id: number;
  productId: number;
  quantity: number;
  salesOrderId: number | null;
}

/** The same product listed twice is one line; in product order, the order locks are taken in. */
function mergeByProduct<T extends { productId: number }>(
  items: T[],
  qty: (i: T) => number,
): { productId: number; quantity: number }[] {
  const sums = new Map<number, number>();
  for (const i of items) sums.set(i.productId, roundQty((sums.get(i.productId) ?? 0) + qty(i)));
  return [...sums]
    .filter(([, quantity]) => quantity > QTY_EPSILON)
    .sort(([a], [b]) => a - b)
    .map(([productId, quantity]) => ({ productId, quantity }));
}

/** Where a handheld transfer is going: an open store, and a place there if one was scanned. */
async function sendEnds(tx: Tx, args: SendArgs) {
  const from = await handheldPlace(tx, args.fromStockLocationId);
  const toStore = await tx.storeLocation.findUnique({
    where: { id: args.toLocationId },
    select: { id: true, name: true, isActive: true },
  });
  if (!toStore?.isActive) throw new TransferPlaceError("Choose an open store to send it to.");
  if (args.toStockLocationId != null) {
    const to = await handheldPlace(tx, args.toStockLocationId);
    if (to.storeLocationId !== toStore.id) {
      throw new TransferPlaceError(`${to.name} isn't at ${toStore.name}.`);
    }
    if (to.id === from.id) throw new TransferPlaceError("It is already there.");
  } else if (toStore.id === from.storeLocationId) {
    throw new TransferPlaceError("Within one store, scan the place it is going to.");
  }
  const fromStore = await tx.storeLocation.findUniqueOrThrow({
    where: { id: from.storeLocationId },
    select: { name: true },
  });
  return { from, fromStoreName: fromStore.name, toStore };
}

/**
 * A transfer sent from a place on the handheld (GAP-19): each product's
 * quantity leaves the place now, into its store's transit place, for another
 * store or a place there. Free units go first, then units committed to orders,
 * as a quick move takes them. Each order's units go on a transfer of their
 * own, so the commitment travels with them as on the desk's transfer for an
 * order. Returns the transfers made, each already on its way.
 */
export async function sendFromPlace(tx: Tx, args: SendArgs): Promise<SentTransfer[]> {
  const items = mergeByProduct(args.items, (i) => i.quantity);
  if (items.length === 0) throw new TransferQuantityError("Nothing to send.");
  const { from, fromStoreName, toStore } = await sendEnds(tx, args);
  const names = new Map(
    (
      await tx.product.findMany({
        where: { id: { in: items.map((i) => i.productId) } },
        select: { id: true, name: true },
      })
    ).map((p) => [p.id, p.name]),
  );
  await lockProducts(
    tx,
    items.map((i) => i.productId),
  );

  const at = { storeLocationId: from.storeLocationId, stockLocationId: from.id };
  const sent: SentTransfer[] = [];
  const now = new Date();
  for (const { productId, quantity } of items) {
    const name = names.get(productId);
    if (!name) throw new TransferPlaceError("That product doesn't exist.");
    const free = await drawLegs(tx, { productId, where: { ...at, salesOrderId: null }, quantity });
    const sold =
      free.shortfall > 0
        ? await drawLegs(tx, {
            productId,
            where: { ...at, salesOrderId: { not: null } },
            quantity: free.shortfall,
          })
        : { legs: [], shortfall: 0 };
    if (sold.shortfall > 0) {
      const there = roundQty(quantity - sold.shortfall);
      throw new TransferQuantityError(`Only ${there} ${name} at ${from.name}.`);
    }

    // Free units on one transfer, then one per order whose units go.
    const groups = new Map<number | null, number>();
    for (const leg of [...free.legs, ...sold.legs]) {
      const owner = leg.place.salesOrderId;
      groups.set(owner, roundQty((groups.get(owner) ?? 0) + leg.take));
    }
    for (const [salesOrderId, q] of groups) {
      const t = await tx.inventoryTransfer.create({
        data: {
          productId,
          quantity: q,
          fromLocation: fromStoreName,
          toLocation: toStore.name,
          fromLocationId: from.storeLocationId,
          fromStockLocationId: from.id,
          toLocationId: toStore.id,
          toStockLocationId: args.toStockLocationId,
          salesOrderId,
          requestedByUserId: args.requestedByUserId,
          status: "IN_TRANSIT",
          shippedAt: now,
        },
      });
      await shipTransfer(tx, t, args.actor, args.actionKey ?? null);
      sent.push({ id: t.id, productId, quantity: q, salesOrderId });
    }
  }
  return sent;
}

export interface ArrivalArgs {
  storeLocationId: number;
  /** Where everything scanned was put; null for each transfer's own place. */
  toStockLocationId: number | null;
  items: { productId: number; units: number }[];
  actor: string | null;
  actionKey?: string | null;
}

/** One product's arrivals, received against its transfers on their way: an order's first, then the oldest. */
async function receiveProduct(
  tx: Tx,
  item: { productId: number; quantity: number },
  args: ArrivalArgs,
  storeName: string,
): Promise<{ touched: number[]; completed: number }> {
  // Locked before reading, so a desk receipt can't take the same units.
  const locked = await tx.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "InventoryTransfer"
    WHERE "status" = 'IN_TRANSIT' AND "toLocationId" = ${args.storeLocationId}::int
      AND "productId" = ${item.productId}::int
    ORDER BY "id" FOR UPDATE`;
  const onWay = await tx.inventoryTransfer.findMany({
    where: { id: { in: locked.map((r) => r.id) } },
    orderBy: [{ salesOrderId: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  });
  const touched: number[] = [];
  let completed = 0;
  let left = item.quantity;
  for (const t of onWay) {
    if (!(left > QTY_EPSILON)) break;
    const take = Math.min(roundQty(toQty(t.quantity) - toQty(t.receivedQuantity)), left);
    if (!(take > QTY_EPSILON)) continue;
    const r = await claimAndReceive(tx, t, take, args.actor, {
      toStockLocationId: args.toStockLocationId,
      actionKey: args.actionKey,
    });
    touched.push(t.id);
    if (r.complete) completed++;
    left = roundQty(left - take);
  }
  if (left > QTY_EPSILON) {
    const product = await tx.product.findUnique({
      where: { id: item.productId },
      select: { name: true },
    });
    const name = product?.name ?? "That product";
    const coming = roundQty(item.quantity - left);
    throw new TransferQuantityError(
      coming > 0
        ? `Only ${coming} ${name} on the way to ${storeName}; ${item.quantity} scanned.`
        : `${name} isn't on its way to ${storeName}.`,
    );
  }
  return { touched, completed };
}

/**
 * What arrived at a store, scanned on the handheld (GAP-19), received against
 * the transfers on their way to it: for each product, transfers for an order
 * first, then the oldest. All of it or none: a product scanned more times than
 * it is on its way is refused, naming it.
 */
export async function receiveArrivals(
  tx: Tx,
  args: ArrivalArgs,
): Promise<{ units: number; transfers: number; completed: number }> {
  const store = await tx.storeLocation.findUnique({
    where: { id: args.storeLocationId },
    select: { name: true },
  });
  if (!store) throw new TransferPlaceError("Choose the store it arrived at.");
  if (args.toStockLocationId != null) {
    const place = await handheldPlace(tx, args.toStockLocationId);
    if (place.storeLocationId !== args.storeLocationId) {
      throw new TransferPlaceError(`${place.name} isn't at ${store.name}.`);
    }
  }
  let units = 0;
  const touched = new Set<number>();
  let completed = 0;
  // Each product's transfer rows, then its stock lock (in receiveTransfer): the
  // order the desk's receipt takes them in, so the two can't deadlock.
  for (const item of mergeByProduct(args.items, (i) => i.units)) {
    const r = await receiveProduct(tx, item, args, store.name);
    for (const id of r.touched) touched.add(id);
    completed += r.completed;
    units = roundQty(units + item.quantity);
  }
  return { units, transfers: touched.size, completed };
}

/** A transfer on its way to a screen: its quantities as numbers, not Decimal strings. */
export function transferForClient<
  T extends { quantity: Prisma.Decimal; receivedQuantity: Prisma.Decimal },
>(t: T) {
  return { ...t, quantity: toQty(t.quantity), receivedQuantity: toQty(t.receivedQuantity) };
}
