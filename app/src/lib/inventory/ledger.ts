// /app/src/lib/inventory/ledger.ts
//
// THE ONLY WRITER OF InventoryPosition.
//
// Every change to stock -- a sale committing a unit, a delivery taking it away,
// a receipt, a transfer, a return, an admin edit, the POS import -- is the same
// small act: N units of one product moved from one place to another. A "place"
// is (store, stock location, owner), where the owner is either nobody (free
// stock) or a sales order (committed stock). Outside Holt's books -- a
// supplier, a customer, a write-off -- is simply no place at all.
//
//   postMovement   move N from a place to a place (either side may be outside)
//   drawLegs       plan "take N from wherever it matches", without writing
//   setPlaceQuantity  make one place hold exactly N, as a movement of the
//                  difference (the POS import and admin edits need this)
//
// Everything else in lib/inventory is built from these three.
//
// THE JOURNAL
//
// Every movement is also written to StockMovement, in the same transaction, with
// why it moved (MOVEMENT_REASONS) and the document that moved it. The journal is
// append-only (a trigger refuses UPDATE and DELETE), so the balance at any place
// can be re-derived from it, and ledgerDrift() checks that it still can. The
// integration suite asserts no drift after every test.
//
// WHY ONE WRITER
//
// Before this file there were nine files writing InventoryPosition, each with
// its own arithmetic. Four of them upserted through the table's compound unique
// key, which holds two nullable columns that Postgres treats as distinct, so the
// upsert never matched a free-stock row and every receipt, restock and transfer
// cancel created another duplicate row (CLAUDE.md rule 64). A transfer whose
// source row was missing shipped nothing and then received stock at the
// destination anyway, so stock appeared from nowhere. Order deletion destroyed
// committed stock instead of returning it. One writer makes each of those
// impossible to write, rather than something every new call site has to
// remember (principle 3, rule 42). __tests__/stockWriterTripwire.test.ts fails
// if any other file writes the table.
//
// HOW IT STAYS CORRECT UNDER CONCURRENCY
//
// Every write takes a transaction-scoped advisory lock on the product before it
// reads the balance it is about to change, so two registers selling the last
// sofa cannot both see it as free. Locks are re-entrant within a transaction,
// so a caller that takes the lock in drawLegs and then posts the legs holds it
// once.
//
// A transaction that touches several products must lock ALL of them once, up
// front, with lockProducts -- which sorts them -- before it moves any stock.
// Locks are held until commit, so a flow that locks product 9 now and product 2
// later can deadlock with one that locks 2 then 9; Postgres then aborts one of
// them. lockProducts called once with the whole set is what prevents that:
// every such transaction takes its locks in the same ascending order.
//
// A place is matched by EXPLICIT equality on every column (rule 64): free
// stock is `salesOrderId: null`, tested as a value, never left out and never
// compared with `not`. Every place has a stock location (NOT NULL), so that
// column is never null.

import type { Prisma, PrismaClient } from "@prisma/client";
import { roundQty, toQty, qtyEquals, qtyIsZero, QTY_EPSILON } from "./quantity";
import { isStockLocationType, LOCATION_TYPE_INFO } from "./locationTypes";

export type PrismaTx = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

/**
 * Where stock sits: a store, the place in it, and who owns it. Every unit is
 * somewhere -- a caller that knows only the store resolves the place with
 * lib/inventory/places.ts (its receiving place).
 */
export interface Place {
  storeLocationId: number;
  stockLocationId: number;
  /** null = free stock; a number = committed to that sales order. */
  salesOrderId: number | null;
}

/**
 * Why stock moved. One catalog (rule 37); StockMovement.reason holds the key.
 */
export const MOVEMENT_REASONS = {
  OPENING: "Already there when the journal started, or first recorded by hand",
  RECEIVE: "Received from a supplier",
  UNRECEIVE: "Taken back off a receipt that was wrong",
  ALLOCATE: "Committed to a sales order",
  RELEASE: "Released from a sales order to free stock",
  DELIVER: "Left with the customer",
  RETURN: "Returned by a customer",
  WRITE_OFF: "Written off: out of the books",
  TRANSFER: "Moved between places",
  ADJUST: "Corrected by hand",
  IMPORT_SYNC: "Set by the POS stock import",
} as const;

export type MovementReason = keyof typeof MOVEMENT_REASONS;

/** The document a movement belongs to, recorded on the journal row. */
export interface MovementSource {
  type:
    "SalesOrder" | "PurchaseOrder" | "Return" | "InventoryTransfer" | "StockCount" | "DeliveryRun";
  id: number;
}

export interface Movement {
  productId: number;
  /** Units to move. Must be positive; fractional for roll goods. */
  quantity: number;
  /** Omitted or null = from outside Holt's books (supplier, customer, opening count). */
  from?: Place | null;
  /** Omitted or null = to outside Holt's books (customer, write-off). */
  to?: Place | null;
  reason: MovementReason;
  source?: MovementSource | null;
  /** Who did it, for createdBy/updatedBy and the journal. */
  actor?: string | null;
  /** Stamped on the destination row when given, and kept on the journal row. */
  note?: string | null;
  /** The handheld action this belongs to (lib/inventory/withAction.ts). */
  actionKey?: string | null;
}

/**
 * A place that can't hold stock: a stock location or store that doesn't exist,
 * one at another store, or a grouping place. The caller named it, so a route
 * answers 400 with this message.
 */
export class PlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceError";
  }
}

/** The source place holds less than the movement asked to take from it. */
export class InsufficientStockError extends Error {
  constructor(
    readonly productId: number,
    readonly place: Place,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Only ${available} of product ${productId} at that place; ${requested} requested.`);
    this.name = "InsufficientStockError";
  }
}

// ---------------------------------------------------------------------------
// PURE ARITHMETIC
// ---------------------------------------------------------------------------

export interface PositionForDraw {
  id: number;
  quantity: number;
}

export interface DrawStep {
  id: number;
  /** Units drawn from this position. */
  take: number;
  /** True when `take` is the position's whole quantity: delete the row rather
   *  than leave it at zero. */
  exhausts: boolean;
}

export interface DrawPlan {
  steps: DrawStep[];
  totalTaken: number;
  /** Units requested but not available anywhere in `positions`. */
  shortfall: number;
}

/**
 * Given positions in draw order and a requested quantity, decide how many units
 * to take from each until the request is met or the positions run out.
 *
 * No I/O and no ordering decisions -- the caller supplies `positions` in the
 * order it wants them drawn. Get the split wrong here and a partial take either
 * removes more than a row holds or leaves a row untouched that should have been
 * drawn down, which is how stock silently doubles.
 */
export function planDraw(positions: PositionForDraw[], requested: number): DrawPlan {
  const steps: DrawStep[] = [];
  let remaining = requested > 0 ? roundQty(requested) : 0;

  for (const position of positions) {
    if (qtyIsZero(remaining) || remaining < 0) break;
    const take = roundQty(Math.min(remaining, position.quantity));
    if (qtyIsZero(take) || take < 0) continue;
    // `qtyEquals`, not `===`. Quantities are fractional, and exact float
    // equality is how a row ends up stranded at 0.0000001 -- in every count,
    // sellable to nobody, and never cleaned up because it never reads as empty.
    steps.push({ id: position.id, take, exhausts: qtyEquals(take, position.quantity) });
    remaining = roundQty(remaining - take);
  }

  return {
    steps,
    totalTaken: requested > 0 ? roundQty(requested - remaining) : 0,
    shortfall: remaining,
  };
}

/** Prisma rows -> the plain shape planDraw works on. */
export function asDrawable(
  rows: { id: number; quantity: Prisma.Decimal | number }[],
): PositionForDraw[] {
  return rows.map((r) => ({ id: r.id, quantity: toQty(r.quantity) }));
}

/** The where-clause for exactly one place, nulls matched explicitly (rule 64). */
export function placeWhere(productId: number, place: Place): Prisma.InventoryPositionWhereInput {
  return {
    productId,
    storeLocationId: place.storeLocationId,
    stockLocationId: place.stockLocationId,
    salesOrderId: place.salesOrderId ?? null,
  };
}

/** The place a position row sits at. */
export function placeOf(row: {
  storeLocationId: number;
  stockLocationId: number;
  salesOrderId: number | null;
}): Place {
  return {
    storeLocationId: row.storeLocationId,
    stockLocationId: row.stockLocationId,
    salesOrderId: row.salesOrderId ?? null,
  };
}

function placeKey(place: Place): string {
  return `${place.storeLocationId}|${place.stockLocationId}|${place.salesOrderId ?? ""}`;
}

// ---------------------------------------------------------------------------
// TRANSACTIONS AND LOCKS
// ---------------------------------------------------------------------------

/**
 * Advisory-lock key space for stock. Postgres keeps the two-int lock space
 * separate from the single-bigint one that lib/orderNumber.ts uses with
 * hashtext(), so these can never collide with an order-number lock.
 */
const STOCK_LOCK_SPACE = 5_461_067;

/**
 * Run `fn` inside a transaction: the caller's, if it passed one, else a new
 * one. A transaction-scoped advisory lock taken outside a transaction would be
 * released the instant it was granted, and a multi-step stock change that is
 * not atomic can half-apply.
 *
 * The root client is recognised by `$disconnect`, which a transaction client
 * does not have. Not by `$transaction`: on Prisma 7 a transaction client has
 * one too, and calling it opens a nested SAVEPOINT -- so testing for it would
 * wrap every call made inside a caller's transaction in a savepoint, contrary
 * to "runs in the caller's transaction".
 */
export async function withStockTx<T>(db: PrismaTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (typeof (db as { $disconnect?: unknown }).$disconnect === "function") {
    return (db as PrismaClient).$transaction((tx) => fn(tx));
  }
  return fn(db as Tx);
}

/** Lock one product's stock for the rest of the transaction. Re-entrant. */
async function lockProduct(tx: Tx, productId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STOCK_LOCK_SPACE}::int, ${productId}::int)`;
}

/**
 * Lock several products in ascending id order. Any operation touching more than
 * one product calls this first, so two such transactions always take their
 * locks in the same order and cannot deadlock on each other.
 */
export async function lockProducts(db: PrismaTx, productIds: number[]): Promise<void> {
  const ids = Array.from(new Set(productIds)).sort((a, b) => a - b);
  await withStockTx(db, async (tx) => {
    for (const id of ids) await lockProduct(tx, id);
  });
}

// ---------------------------------------------------------------------------
// THE PRIMITIVES
// ---------------------------------------------------------------------------

/**
 * Move `quantity` units of one product from one place to another.
 *
 * - `from` set: takes the units from that exact place, oldest row first, and
 *   throws InsufficientStockError -- writing nothing -- if the place holds
 *   fewer. It never takes from somewhere else and never goes negative.
 * - `to` set: adds the units to that exact place, merging into its existing row
 *   rather than creating a second one.
 * - Either side may be omitted, meaning outside Holt's books.
 */
export async function postMovement(db: PrismaTx, movement: Movement): Promise<void> {
  if (!Number.isFinite(movement.quantity)) {
    throw new Error(`A stock movement needs a numeric quantity; got ${movement.quantity}.`);
  }
  const quantity = roundQty(movement.quantity);
  if (!(quantity > 0) || qtyIsZero(quantity)) {
    throw new Error(`A stock movement must move a positive quantity; got ${movement.quantity}.`);
  }
  if (!movement.from && !movement.to) {
    throw new Error("A stock movement needs a place on at least one side.");
  }
  if (!(movement.reason in MOVEMENT_REASONS)) {
    throw new Error(`Unknown stock movement reason: ${movement.reason}.`);
  }

  await withStockTx(db, async (tx) => {
    await lockProduct(tx, movement.productId);
    const actor = movement.actor ?? null;

    if (movement.from) {
      const rows = await tx.inventoryPosition.findMany({
        where: placeWhere(movement.productId, movement.from),
        orderBy: { id: "asc" },
      });
      const available = roundQty(rows.reduce((sum, r) => sum + toQty(r.quantity), 0));
      if (available + QTY_EPSILON < quantity) {
        throw new InsufficientStockError(movement.productId, movement.from, quantity, available);
      }
      const plan = planDraw(asDrawable(rows), quantity);
      for (const step of plan.steps) {
        if (step.exhausts) {
          await tx.inventoryPosition.delete({ where: { id: step.id } });
        } else {
          await tx.inventoryPosition.update({
            where: { id: step.id },
            data: { quantity: { decrement: step.take }, updatedBy: actor },
          });
        }
      }
    }

    if (movement.to) {
      const existing = await tx.inventoryPosition.findFirst({
        where: placeWhere(movement.productId, movement.to),
        orderBy: { id: "asc" },
      });
      const note = movement.note === undefined ? {} : { notes: movement.note };
      if (existing) {
        await tx.inventoryPosition.update({
          where: { id: existing.id },
          data: { quantity: { increment: quantity }, updatedBy: actor, ...note },
        });
      } else {
        await assertPlaceAtStore(tx, movement.to);
        await tx.inventoryPosition.create({
          data: {
            productId: movement.productId,
            storeLocationId: movement.to.storeLocationId,
            stockLocationId: movement.to.stockLocationId,
            salesOrderId: movement.to.salesOrderId ?? null,
            quantity,
            createdBy: actor,
            ...note,
          },
        });
      }
    }

    await tx.stockMovement.create({
      data: {
        productId: movement.productId,
        quantity,
        fromStoreLocationId: movement.from?.storeLocationId ?? null,
        fromStockLocationId: movement.from?.stockLocationId ?? null,
        fromSalesOrderId: movement.from?.salesOrderId ?? null,
        toStoreLocationId: movement.to?.storeLocationId ?? null,
        toStockLocationId: movement.to?.stockLocationId ?? null,
        toSalesOrderId: movement.to?.salesOrderId ?? null,
        reason: movement.reason,
        sourceType: movement.source?.type ?? null,
        sourceId: movement.source?.id ?? null,
        actor,
        note: movement.note ?? null,
        actionKey: movement.actionKey ?? null,
      },
    });
  });
}

/**
 * A place is in its store and can hold stock. Checked when a movement opens a
 * new row, the only time a (store, place) pair enters the table: a unit
 * recorded at one store in another store's stock room would be counted at the
 * wrong site for good, and a GROUP place (a building, a floor) holds places,
 * not units.
 */
async function assertPlaceAtStore(tx: Tx, place: Place): Promise<void> {
  const location = await tx.stockLocation.findUnique({
    where: { id: place.stockLocationId },
    select: { storeLocationId: true, locationType: true, name: true },
  });
  if (!location) {
    throw new PlaceError(`Stock location ${place.stockLocationId} does not exist.`);
  }
  if (location.storeLocationId !== place.storeLocationId) {
    throw new PlaceError(
      `Stock location ${place.stockLocationId} is not at store ${place.storeLocationId}.`,
    );
  }
  if (
    isStockLocationType(location.locationType) &&
    !LOCATION_TYPE_INFO[location.locationType].holdsStock
  ) {
    throw new PlaceError(
      `"${location.name}" groups places and holds no stock itself; choose a place inside it.`,
    );
  }
}

export interface DrawLeg {
  place: Place;
  take: number;
}

export interface DrawLegsResult {
  legs: DrawLeg[];
  /** Units requested that no matching place could supply. */
  shortfall: number;
}

/**
 * Plan "take `quantity` of this product from wherever `where` matches", oldest
 * row first, without writing anything. The caller posts one movement per leg.
 *
 * Takes the product lock first, so the plan stays true for the rest of the
 * caller's transaction. Pass the caller's transaction for exactly that reason;
 * called with the root client, the lock and the plan end with the call.
 */
export async function drawLegs(
  db: PrismaTx,
  args: { productId: number; where: Prisma.InventoryPositionWhereInput; quantity: number },
): Promise<DrawLegsResult> {
  return withStockTx(db, async (tx) => {
    await lockProduct(tx, args.productId);
    // AND, not a spread: `where` may carry its own OR (freePositionWhere does),
    // and spreading a second clause beside it could overwrite that disjunction.
    const rows = await tx.inventoryPosition.findMany({
      where: { AND: [args.where, { productId: args.productId }] },
      orderBy: { id: "asc" },
    });
    const plan = planDraw(asDrawable(rows), args.quantity);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const legs = new Map<string, DrawLeg>();
    for (const step of plan.steps) {
      const place = placeOf(byId.get(step.id)!);
      const key = placeKey(place);
      const leg = legs.get(key);
      if (leg) leg.take = roundQty(leg.take + step.take);
      else legs.set(key, { place, take: step.take });
    }
    return { legs: Array.from(legs.values()), shortfall: plan.shortfall };
  });
}

/**
 * Make one place hold exactly `target` units, as a movement of the difference.
 * Returns the change applied (positive = added, negative = removed, 0 = none).
 *
 * For the POS stock import, which reports absolute on-hand, and for admin
 * edits that state a quantity. Everything else should say what moved instead.
 */
export async function setPlaceQuantity(
  db: PrismaTx,
  args: {
    productId: number;
    place: Place;
    target: number;
    reason: MovementReason;
    source?: MovementSource | null;
    actor?: string | null;
    note?: string | null;
  },
): Promise<number> {
  if (!Number.isFinite(args.target)) {
    throw new Error(`A place's quantity must be a number; got ${args.target}.`);
  }
  const target = roundQty(args.target);
  if (target < 0) {
    throw new Error(`A place cannot hold a negative quantity; got ${args.target}.`);
  }
  return withStockTx(db, async (tx) => {
    await lockProduct(tx, args.productId);
    const agg = await tx.inventoryPosition.aggregate({
      where: placeWhere(args.productId, args.place),
      _sum: { quantity: true },
    });
    const current = toQty(agg._sum.quantity);
    const delta = roundQty(target - current);

    if (delta > 0 && !qtyIsZero(delta)) {
      await postMovement(tx, {
        productId: args.productId,
        quantity: delta,
        to: args.place,
        reason: args.reason,
        source: args.source,
        actor: args.actor,
        note: args.note,
      });
    } else if (delta < 0 && !qtyIsZero(delta)) {
      await postMovement(tx, {
        productId: args.productId,
        quantity: -delta,
        from: args.place,
        reason: args.reason,
        source: args.source,
        actor: args.actor,
      });
    }

    // A note can change even when the quantity does not (the import records
    // where an unmatched row came from on every run). `null` clears it, the
    // same as in postMovement; `undefined` leaves it alone.
    if (args.note !== undefined && !(delta > 0)) {
      const row = await tx.inventoryPosition.findFirst({
        where: placeWhere(args.productId, args.place),
        orderBy: { id: "asc" },
      });
      if (row && row.notes !== args.note) {
        await tx.inventoryPosition.update({
          where: { id: row.id },
          data: { notes: args.note, updatedBy: args.actor ?? null },
        });
      }
    }

    return qtyIsZero(delta) ? 0 : delta;
  });
}

// ---------------------------------------------------------------------------
// THE CHECK
// ---------------------------------------------------------------------------

export interface LedgerDrift {
  productId: number;
  storeLocationId: number;
  stockLocationId: number;
  salesOrderId: number | null;
  /** What the journal says the place holds. */
  journal: number;
  /** What InventoryPosition says it holds. */
  balance: number;
}

/**
 * Every place where the balance is not the sum of the journal: what moved in,
 * minus what moved out. Empty when stock and its history agree.
 *
 * It can disagree for exactly the reasons it exists to catch: a write to
 * InventoryPosition that did not go through postMovement, or a journal row that
 * was lost. Pass `productIds` to check only those products.
 */
export async function ledgerDrift(db: PrismaTx, productIds?: number[]): Promise<LedgerDrift[]> {
  const filter = productIds && productIds.length > 0 ? productIds : null;
  const rows = await db.$queryRaw<
    {
      productId: number;
      storeLocationId: number;
      stockLocationId: number;
      salesOrderId: number | null;
      journal: string;
      balance: string;
    }[]
  >`
    WITH legs AS (
      SELECT "productId", "toStoreLocationId" AS s, "toStockLocationId" AS l,
             "toSalesOrderId" AS o, quantity AS q
      FROM "StockMovement" WHERE "toStoreLocationId" IS NOT NULL
      UNION ALL
      SELECT "productId", "fromStoreLocationId", "fromStockLocationId",
             "fromSalesOrderId", -quantity
      FROM "StockMovement" WHERE "fromStoreLocationId" IS NOT NULL
    ),
    journal AS (
      SELECT "productId", s, l, o, SUM(q) AS q FROM legs GROUP BY 1, 2, 3, 4
    ),
    balance AS (
      SELECT "productId", "storeLocationId" AS s, "stockLocationId" AS l,
             "salesOrderId" AS o, SUM(quantity) AS q
      FROM "InventoryPosition" GROUP BY 1, 2, 3, 4
    )
    SELECT COALESCE(j."productId", b."productId") AS "productId",
           COALESCE(j.s, b.s) AS "storeLocationId",
           COALESCE(j.l, b.l) AS "stockLocationId",
           COALESCE(j.o, b.o) AS "salesOrderId",
           COALESCE(j.q, 0)::text AS journal,
           COALESCE(b.q, 0)::text AS balance
    FROM journal j
    FULL OUTER JOIN balance b
      ON b."productId" = j."productId" AND b.s = j.s AND b.l = j.l
     AND b.o IS NOT DISTINCT FROM j.o
    WHERE COALESCE(j.q, 0) <> COALESCE(b.q, 0)
      AND (${filter}::int[] IS NULL OR COALESCE(j."productId", b."productId") = ANY(${filter}::int[]))
    ORDER BY 1, 2, 3, 4
  `;
  return rows.map((r) => ({
    productId: r.productId,
    storeLocationId: r.storeLocationId,
    stockLocationId: r.stockLocationId,
    salesOrderId: r.salesOrderId,
    journal: Number(r.journal),
    balance: Number(r.balance),
  }));
}
