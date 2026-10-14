// /app/src/lib/inventory/allocation.ts
//
// WHY THIS FILE EXISTS
//
// Before this module, nothing in holt ever decremented on-hand inventory for
// a sale. Every writer of InventoryPosition either added stock (Ordorite
// import, PO receiving, returns) or moved it sideways (warehouse transfers,
// manual edits). Selling, fulfilling, and delivering had zero effect on
// on-hand -- a store could sell the same sofa to five customers and the
// floor would still say one.
//
// The schema was already built for the fix: InventoryPosition has a nullable
// `salesOrderId` FK, and its unique key is
// [productId, storeLocationId, stockLocationId, salesOrderId]. That shape
// only makes sense as ALLOCATE-THEN-CONSUME -- a row with salesOrderId set is
// committed to that order and is not free stock -- but nobody ever wrote the
// code that used it. `salesOrderId` was never populated in imported data.
//
// TWO SIGNALS FOR "SPOKEN FOR" -- HONOURED, NOT UNIFIED
//
// Because salesOrderId was never populated, the source system a deployment
// imports from may carry its own convention for "committed to a customer" --
// typically a holding location that stock is moved to. holt reads that as a
// flag on the location itself, not as a fact about its name. Two signals,
// both honoured:
//
//   - salesOrderId set                     -> committed via THIS module (native sale)
//   - StockLocation.holdsCommittedStock    -> committed by whoever put it there
//
// A position is free stock only if neither signal is present.
//
// The flag is set by an admin (warehouse -> locations) or derived by an
// import adapter from its own source convention -- the Ordorite adapter
// derives it from that deployment's "Customer%" location naming, in
// src/lib/adapters/ordorite/shared.ts. That naming convention is real in
// the imported data, and the migration that added the flag backfilled it
// from exactly that string test, so imported data behaves as before. It is
// one adapter's fact about its source, though, not something shared
// inventory code is entitled to assume (CLAUDE.md rule 61).
//
// This module does NOT migrate imported rows and does not change how
// buyersReport interprets them; buyersReport reads the same flag.
//
// THE FOUR OPERATIONS
//
//   allocate  -- on sale. Commits free stock to an order, splitting a
//                position if the sale doesn't take all of it.
//   release   -- on cancel, or when a line is removed/changed. Returns an
//                order's committed stock to free, merging back into an
//                existing free position rather than leaving fragments.
//   consume   -- on fulfilment/delivery. The goods left the building:
//                committed positions are deleted outright, not just freed.
//   availableQuantity -- free stock only, for the POS to show what's
//                actually sellable right now.
//
// None of these write InventoryPosition themselves: each one is a few
// movements posted through lib/inventory/ledger.ts, the table's only writer.
//
// Every function takes the caller's transaction client and does all of its
// reads and writes inside it. Allocation that is not atomic with the order
// write is exactly how you'd get stock committed to an order that then
// failed to save.
//
// OVERSELLING IS ALLOWED, ON PURPOSE
//
// A furniture store sells floor models, special orders, and things arriving
// next week. `allocate` commits whatever free stock exists (partially, if
// necessary) and reports the shortfall -- it never throws and never blocks
// the sale. See PosView.tsx: "Failures are silently ignored -- inventory
// never blocks a sale." That is a deliberate business rule, not a gap.

import type { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { toQty, roundQty } from "./quantity";
import { drawLegs, dropEmptyRow, lockProducts, postMovement, withStockTx } from "./ledger";
import type { PrismaTx, Place } from "./ledger";

// The draw arithmetic and the transaction type moved to ledger.ts, the single
// writer of InventoryPosition. Re-exported so existing importers keep working.
export { planDraw } from "./ledger";
export type { PrismaTx, PositionForDraw, DrawStep, DrawPlan } from "./ledger";

/** A line to allocate: one product, one quantity, one store. */
export interface AllocationLine {
  productId: number;
  /** Whole units. Non-positive quantities (e.g. a return line) are skipped. */
  quantity: number;
  storeLocationId: number;
}

/** A line to consume: allocation is already store-scoped via salesOrderId,
 *  so consumption only needs the product and how many units are leaving. */
export interface ConsumptionLine {
  productId: number;
  quantity: number;
}

export interface AllocationShortfall {
  productId: number;
  storeLocationId: number;
  requested: number;
  allocated: number;
  shortfall: number;
}

export interface AllocationResult {
  /** Empty when every line was fully allocated. Non-empty is not an error --
   *  see the file header. Callers should log it, never reject the sale. */
  shortfalls: AllocationShortfall[];
}

// ---------------------------------------------------------------------------
// I/O -- everything below runs inside the caller's transaction.
// ---------------------------------------------------------------------------

/**
 * The free-stock predicate, in one place, so allocate/availableQuantity and
 * anything else that needs "is this position free to sell" can never drift
 * from each other. A position is free when:
 *   - it is not committed to an order (salesOrderId is null), AND
 *   - it is not sitting in a location flagged as holding committed stock.
 *
 * Rule 51, twice. `salesOrderId: null` is an explicit equality check, never a
 * `not`, because it's the nullable column we actually mean to test. And
 * `stockLocationId` is nullable too -- a position with NO stock location is
 * free stock -- so the location test is written as an explicit disjunction
 * rather than a `NOT: { stockLocation: {...} }`. A relation-level NOT on a
 * nullable to-one relation is exactly the three-valued-logic hazard rule 51
 * warns about: it is the difference between "the location does not hold
 * committed stock" and "there is no location", and getting it wrong drops
 * every location-less position out of available stock silently.
 *
 * Callers spread the result into a larger where clause. Any caller that also
 * needs a disjunction of its own must nest it under `AND`, NOT set a
 * sibling `OR:` -- an object-literal spread would overwrite the one below
 * and silently re-admit committed stock as free. No caller does today
 * (availableQuantity and allocate, both in this file).
 */
export function freePositionWhere(): Prisma.InventoryPositionWhereInput {
  return {
    salesOrderId: null,
    OR: [{ stockLocationId: null }, { stockLocation: { holdsCommittedStock: false } }],
  };
}

/**
 * Free (sellable) on-hand quantity for one product at one store. This is
 * what the POS should show -- raw InventoryPosition.quantity includes stock
 * already committed to another order, which is not available to sell again.
 */
export async function availableQuantity(
  productId: number,
  storeLocationId: number,
  tx: PrismaTx,
): Promise<number> {
  const result = await tx.inventoryPosition.aggregate({
    where: { ...freePositionWhere(), productId, storeLocationId },
    _sum: { quantity: true },
  });
  return toQty(result._sum.quantity);
}

/**
 * Commit free stock to an order, one line at a time.
 *
 * Allocation is a movement that does not change the place, only the owner: the
 * units stay where they are and pass from free stock to the order. Free stock
 * is drawn oldest row first (deterministic, roughly FIFO by when it was
 * recorded) by ledger.drawLegs, and each leg is posted with ledger.postMovement,
 * which merges into the order's existing row for that place -- two cart lines
 * for the same product are the ordinary case, not an edge one.
 *
 * Every product in the cart is locked once, in ascending id order, before
 * anything is read, so two registers selling overlapping carts cannot both take
 * the last unit or deadlock each other. A caller that will also touch other
 * products in the same transaction must lock its whole set first (see
 * resyncOrderAllocation).
 *
 * Never throws for insufficient stock. Returns shortfalls instead -- see the
 * file header on why overselling is allowed.
 */
export async function allocate(
  orderId: number,
  lines: AllocationLine[],
  db: PrismaTx,
): Promise<AllocationResult> {
  return withStockTx(db, (tx) => allocateIn(orderId, lines, tx));
}

async function allocateIn(
  orderId: number,
  lines: AllocationLine[],
  tx: PrismaTx,
): Promise<AllocationResult> {
  const shortfalls: AllocationShortfall[] = [];
  const active = lines.filter((line) => line.quantity > 0); // returns/no-ops never allocate
  await lockProducts(
    tx,
    active.map((l) => l.productId),
  );

  for (const line of active) {
    const { legs, shortfall } = await drawLegs(tx, {
      productId: line.productId,
      where: { AND: [freePositionWhere(), { storeLocationId: line.storeLocationId }] },
      quantity: line.quantity,
    });

    for (const leg of legs) {
      await postMovement(tx, {
        productId: line.productId,
        quantity: leg.take,
        from: leg.place,
        to: { ...leg.place, salesOrderId: orderId },
      });
    }

    if (shortfall > 0) {
      shortfalls.push({
        productId: line.productId,
        storeLocationId: line.storeLocationId,
        requested: line.quantity,
        allocated: roundQty(line.quantity - shortfall),
        shortfall,
      });
    }
  }

  if (shortfalls.length > 0) {
    logger.warn("Inventory allocation shortfall -- sale proceeding oversold", {
      orderId,
      shortfalls,
    });
  }

  return { shortfalls };
}

/**
 * Return everything an order has committed back to free stock.
 *
 * Unscoped by line on purpose. Callers that need to change just one line
 * release the WHOLE order and re-`allocate` the lines that should still be
 * committed; two-directional delta math on split/merged positions is where a
 * partial-release implementation would go wrong, and a full resync inside one
 * transaction costs nothing extra a user would notice.
 *
 * Each committed place is moved back to the free place beside it, which
 * ledger.postMovement merges into the existing free row -- releasing twice
 * never leaves free stock fragmented into a pile of qty-1 rows.
 */
export async function release(orderId: number, db: PrismaTx): Promise<void> {
  return withStockTx(db, (tx) => releaseIn(orderId, tx));
}

async function releaseIn(orderId: number, tx: PrismaTx): Promise<void> {
  // Lock first, then read the rows to move under the lock: a balance read
  // before the lock can already be stale when it is acted on.
  const products = await tx.inventoryPosition.findMany({
    where: { salesOrderId: orderId },
    select: { productId: true },
    distinct: ["productId"],
  });
  await lockProducts(
    tx,
    products.map((p) => p.productId),
  );
  const committed = await tx.inventoryPosition.findMany({
    where: { salesOrderId: orderId },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });

  // One movement per (product, place), summed, so duplicate committed rows
  // (possible in data written before the single writer existed) move together.
  const byPlace = new Map<string, { productId: number; place: Place; quantity: number }>();
  for (const row of committed) {
    // A committed row holding nothing (written before the single writer) is
    // dropped rather than left on the order, where it would linger and, if the
    // order were deleted, become a stray free row.
    if (toQty(row.quantity) <= 0) {
      await dropEmptyRow(tx, row.id);
      continue;
    }
    const place: Place = {
      storeLocationId: row.storeLocationId,
      stockLocationId: row.stockLocationId ?? null,
      salesOrderId: orderId,
    };
    const key = `${row.productId}|${row.storeLocationId}|${row.stockLocationId ?? ""}`;
    const entry = byPlace.get(key);
    if (entry) entry.quantity = roundQty(entry.quantity + toQty(row.quantity));
    else byPlace.set(key, { productId: row.productId, place, quantity: toQty(row.quantity) });
  }

  for (const { productId, place, quantity } of byPlace.values()) {
    if (!(quantity > 0)) continue;
    await postMovement(tx, {
      productId,
      quantity,
      from: place,
      to: { ...place, salesOrderId: null },
    });
  }
}

/**
 * The goods have left the building: remove the order's committed stock, up to
 * the quantity fulfilled per product. A movement to outside the books -- there
 * is nowhere left for the unit to be.
 *
 * Bounded by `lines` quantities (not "delete everything the order has") so a
 * partial fulfilment can consume less than the full allocation.
 *
 * If fewer units are committed than requested (allocate() could only partially
 * cover the sale), consumes what exists and stops -- there is nothing left to
 * remove, and that is not an error either.
 */
export async function consume(
  orderId: number,
  lines: ConsumptionLine[],
  db: PrismaTx,
): Promise<void> {
  return withStockTx(db, (tx) => consumeIn(orderId, lines, tx));
}

async function consumeIn(orderId: number, lines: ConsumptionLine[], tx: PrismaTx): Promise<void> {
  const active = lines.filter((line) => line.quantity > 0);
  await lockProducts(
    tx,
    active.map((l) => l.productId),
  );

  for (const line of active) {
    const { legs } = await drawLegs(tx, {
      productId: line.productId,
      where: { salesOrderId: orderId },
      quantity: line.quantity,
    });
    for (const leg of legs) {
      await postMovement(tx, { productId: line.productId, quantity: leg.take, from: leg.place });
    }
  }
}
