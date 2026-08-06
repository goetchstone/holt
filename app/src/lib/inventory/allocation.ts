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
// code that used it. `salesOrderId` sat 100% NULL in production data.
//
// TWO SIGNALS FOR "SPOKEN FOR" -- HONOURED, NOT UNIFIED
//
// Because salesOrderId was never populated, the Ordorite import adapter grew
// its own convention: imported stock that's committed to a customer gets
// moved to a StockLocation whose name starts with "Customer" (see
// src/lib/reports/buyersReport.ts). That convention is real in 50k+ imported
// orders and buyersReport already reads it. This module does NOT migrate
// those rows or change how buyersReport interprets them -- it just makes
// sure NATIVE holt sales never treat a Customer-location row as free stock
// to allocate from. Two signals, both honoured:
//
//   - salesOrderId set                 -> committed via THIS module (native sale)
//   - StockLocation.name ~ 'Customer%' -> committed via the Ordorite convention
//
// A position is free stock only if neither signal is present.
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

import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "@/lib/logger";

export type PrismaTx = PrismaClient | Prisma.TransactionClient;

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
// PURE ARITHMETIC -- unit-testable without a database.
// ---------------------------------------------------------------------------

export interface PositionForDraw {
  id: number;
  quantity: number;
}

export interface DrawStep {
  id: number;
  /** Units drawn from this position. */
  take: number;
  /** True when `take` equals the position's full quantity -- the caller
   *  should delete the row rather than decrement it, or it would sit at
   *  quantity 0 forever. */
  exhausts: boolean;
}

export interface DrawPlan {
  steps: DrawStep[];
  totalTaken: number;
  /** Units requested but not available anywhere in `positions`. */
  shortfall: number;
}

/**
 * Given positions in draw order and a requested quantity, decide how many
 * units to take from each, in order, until the request is satisfied or
 * positions run out.
 *
 * This is the one piece of the allocation model worth unit-testing without a
 * database, because both directions of "nothing decrements inventory" trace
 * back to it: allocate() draws from free positions to commit stock to an
 * order, and consume() draws from an order's committed positions to remove
 * stock that has shipped. Get the split wrong here and a partial sale either
 * takes more than a position holds (impossible on paper, catastrophic in a
 * ledger) or leaves a position untouched that should have been drawn down --
 * which is how inventory silently doubles.
 *
 * No I/O, no ordering decisions (the caller supplies `positions` already in
 * the order it wants them drawn), just the arithmetic.
 */
export function planDraw(positions: PositionForDraw[], requested: number): DrawPlan {
  const steps: DrawStep[] = [];
  let remaining = requested > 0 ? requested : 0;

  for (const position of positions) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, position.quantity);
    if (take <= 0) continue;
    steps.push({ id: position.id, take, exhausts: take === position.quantity });
    remaining -= take;
  }

  return { steps, totalTaken: requested > 0 ? requested - remaining : 0, shortfall: remaining };
}

// ---------------------------------------------------------------------------
// I/O -- everything below runs inside the caller's transaction.
// ---------------------------------------------------------------------------

/**
 * The free-stock predicate, in one place, so allocate/availableQuantity and
 * anything else that needs "is this position free to sell" can never drift
 * from each other. A position is free when:
 *   - it is not committed to an order (salesOrderId is null), AND
 *   - it is not sitting in an Ordorite "Customer%" holding location.
 *
 * Rule 51: `salesOrderId: null` is written as an explicit equality check,
 * never a `not`, because it's the nullable column we actually mean to test.
 * The Customer-location exclusion is a relation-level NOT instead of a
 * `stockLocationId: { not: X }` comparison -- filtering through the related
 * StockLocation's name means a position with no stock location at all
 * (stockLocationId null) correctly counts as free (there is no related row
 * for "NOT EXISTS" to match against), rather than being silently dropped by
 * three-valued logic on the nullable FK itself.
 */
export function freePositionWhere(): Prisma.InventoryPositionWhereInput {
  return {
    salesOrderId: null,
    NOT: {
      stockLocation: { name: { startsWith: "Customer", mode: "insensitive" } },
    },
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
  return result._sum.quantity ?? 0;
}

/**
 * Commit free stock to an order, one line at a time.
 *
 * Free positions are drawn down oldest-id-first (deterministic, and roughly
 * FIFO by when the stock was recorded) via planDraw(). Every unit taken
 * moves through an upsert into the order's allocated position for that
 * (product, store, stock location) rather than an in-place update of the
 * source row -- an in-place update could collide with the unique key
 * [productId, storeLocationId, stockLocationId, salesOrderId] if this
 * product already has an allocated row for this order (e.g. two cart lines
 * for the same product). The upsert makes that collision the normal,
 * merging case instead of a unique-constraint error.
 *
 * Never throws for insufficient stock. Returns shortfalls instead -- see the
 * file header on why overselling is allowed.
 */
export async function allocate(
  orderId: number,
  lines: AllocationLine[],
  tx: PrismaTx,
): Promise<AllocationResult> {
  const shortfalls: AllocationShortfall[] = [];

  for (const line of lines) {
    if (!(line.quantity > 0)) continue; // defensive: returns/no-ops never allocate

    const freePositions = await tx.inventoryPosition.findMany({
      where: {
        ...freePositionWhere(),
        productId: line.productId,
        storeLocationId: line.storeLocationId,
      },
      orderBy: { id: "asc" },
    });

    const plan = planDraw(freePositions, line.quantity);
    const byId = new Map(freePositions.map((p) => [p.id, p]));

    for (const step of plan.steps) {
      const position = byId.get(step.id)!;

      await tx.inventoryPosition.upsert({
        where: {
          productId_storeLocationId_stockLocationId_salesOrderId: {
            productId: line.productId,
            storeLocationId: line.storeLocationId,
            stockLocationId: (position.stockLocationId ?? null) as number,
            salesOrderId: orderId,
          },
        },
        update: { quantity: { increment: step.take } },
        create: {
          productId: line.productId,
          storeLocationId: line.storeLocationId,
          stockLocationId: position.stockLocationId ?? null,
          salesOrderId: orderId,
          quantity: step.take,
        },
      });

      if (step.exhausts) {
        await tx.inventoryPosition.delete({ where: { id: position.id } });
      } else {
        await tx.inventoryPosition.update({
          where: { id: position.id },
          data: { quantity: { decrement: step.take } },
        });
      }
    }

    if (plan.shortfall > 0) {
      shortfalls.push({
        productId: line.productId,
        storeLocationId: line.storeLocationId,
        requested: line.quantity,
        allocated: plan.totalTaken,
        shortfall: plan.shortfall,
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
 * Unscoped by line on purpose -- see the file header on why this signature
 * has no `lines` parameter. Callers that need to change just one line
 * release the WHOLE order and re-`allocate` the lines that should still be
 * committed; two-directional delta math on split/merged positions is where
 * a partial-release implementation would go wrong, and a full resync inside
 * one transaction costs nothing extra a user would notice.
 *
 * Each allocated position is merged into the matching free position for the
 * same (product, store, stock location) via upsert-increment, never a bare
 * `create` -- the unique key means a naive create fails outright the second
 * time the same slot is released, and merging (not just avoiding the error)
 * is what keeps free stock from fragmenting into a pile of qty-1 rows.
 */
export async function release(orderId: number, tx: PrismaTx): Promise<void> {
  const allocated = await tx.inventoryPosition.findMany({
    where: { salesOrderId: orderId },
  });

  for (const position of allocated) {
    await tx.inventoryPosition.upsert({
      where: {
        productId_storeLocationId_stockLocationId_salesOrderId: {
          productId: position.productId,
          storeLocationId: position.storeLocationId,
          stockLocationId: (position.stockLocationId ?? null) as number,
          salesOrderId: null as unknown as number,
        },
      },
      update: { quantity: { increment: position.quantity } },
      create: {
        productId: position.productId,
        storeLocationId: position.storeLocationId,
        stockLocationId: position.stockLocationId ?? null,
        quantity: position.quantity,
      },
    });

    await tx.inventoryPosition.delete({ where: { id: position.id } });
  }
}

/**
 * The goods have left the building: delete the order's committed positions
 * outright, up to the quantity fulfilled per product. Unlike allocate/release,
 * consumption is not a stock-location move -- there is nowhere left for the
 * unit to be, so the row is removed rather than transferred. Uses the same
 * planDraw() arithmetic as allocate(), drawing from the order's allocated
 * positions instead of free ones.
 *
 * Bounded by `lines` quantities (not "delete everything the order has") so a
 * future partial fulfilment can consume less than the full allocation. Today
 * every caller passes the order's full active-line quantities, which is
 * equivalent to "delete it all" -- but getting there by summing what was
 * actually asked for, position by position, means the arithmetic doesn't
 * have to change shape the day partial fulfilment shows up.
 *
 * If fewer units are allocated than requested (allocate() could only
 * partially cover the sale), consumes what exists and stops -- there is
 * nothing left to remove, and that is not an error either.
 */
export async function consume(
  orderId: number,
  lines: ConsumptionLine[],
  tx: PrismaTx,
): Promise<void> {
  for (const line of lines) {
    if (!(line.quantity > 0)) continue;

    const allocated = await tx.inventoryPosition.findMany({
      where: { salesOrderId: orderId, productId: line.productId },
      orderBy: { id: "asc" },
    });

    const plan = planDraw(allocated, line.quantity);
    const byId = new Map(allocated.map((p) => [p.id, p]));

    for (const step of plan.steps) {
      const position = byId.get(step.id)!;
      if (step.exhausts) {
        await tx.inventoryPosition.delete({ where: { id: position.id } });
      } else {
        await tx.inventoryPosition.update({
          where: { id: position.id },
          data: { quantity: { decrement: step.take } },
        });
      }
    }
  }
}
