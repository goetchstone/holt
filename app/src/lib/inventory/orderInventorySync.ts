// /app/src/lib/inventory/orderInventorySync.ts
//
// Wiring layer between SalesOrder / OrderLineItem writes and the allocation
// module (src/lib/inventory/allocation.ts). allocation.ts is the proven
// primitive -- allocate/release/consume -- and is not modified here. This
// file only prepares its inputs (which lines are "active", which store the
// order belongs to) and records what allocate() reports back, so every
// call site (create-from-cart, line-item edits, fulfilment, cancellation)
// does the same thing instead of five slightly different re-implementations.

import type { PrismaTx, AllocationLine, AllocationShortfall } from "@/lib/inventory/allocation";
import { allocate, releaseUnits } from "@/lib/inventory/allocation";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { lockProducts } from "@/lib/inventory/ledger";
import { buildLocationMap } from "@/lib/storeLocationResolver";
import { logger } from "@/lib/logger";
import { settleShortfalls } from "@/lib/reports/oversold";

export interface OrderLineForAllocation {
  productId: number;
  /** May be negative for a return line -- allocate()/consume() both skip
   *  non-positive quantities, so callers can pass this straight through. */
  quantity: number;
  /** The customer takes it today (the line is TAKE, or the order is TAKEN). */
  takeWith: boolean;
}

/**
 * Resolve a SalesOrder's free-text `storeLocation` string to a
 * StoreLocation id, inside the caller's transaction so it sees any location
 * created earlier in the same transaction. `SalesOrder.storeLocationId` is
 * never populated anywhere in this codebase -- only the string is -- so this
 * is the only way to get an id for allocation's `storeLocationId` field.
 *
 * Returns null (never throws) when the string is missing or unmatched.
 * Callers must skip allocation and log, not fail the write that already
 * committed -- inventory bookkeeping must never be why a sale fails.
 */
export async function resolveOrderStoreLocationId(
  storeLocation: string | null | undefined,
  tx: PrismaTx,
): Promise<number | null> {
  if (!storeLocation) return null;
  const map = await buildLocationMap(tx);
  return map.get(storeLocation.toLowerCase()) ?? null;
}

/**
 * The order's currently-active, product-linked lines: not CANCELLED, not
 * REPLACED (a replaced line's quantity has already moved to the ACTIVE
 * replacement line that superseded it), and has a productId (a line with no
 * linked product has no InventoryPosition to draw from or commit to).
 *
 * `quantity` is what is still to fulfil: ordered less `fulfilledQty`. Units a
 * part delivery already handed over (lib/fulfilment/handover.ts) are gone, so
 * a resync must not commit stock for them again, and the final handover
 * consumes only the rest.
 *
 * Shape doubles as both AllocationLine (add a storeLocationId) and
 * ConsumptionLine (used as-is) -- see allocation.ts's interfaces.
 */
export async function getActiveOrderLines(
  orderId: number,
  tx: PrismaTx,
): Promise<OrderLineForAllocation[]> {
  const lines = await tx.orderLineItem.findMany({
    where: { salesOrderId: orderId, lineItemStatus: "ACTIVE", productId: { not: null } },
    select: {
      productId: true,
      orderedQuantity: true,
      fulfilledQty: true,
      fulfillment: true,
      salesOrder: { select: { deliveryMethod: true } },
    },
  });
  return lines.map((l) => {
    const ordered = toQty(l.orderedQuantity);
    return {
      productId: l.productId as number,
      // A return line (negative) has nothing to fulfil; it passes through.
      quantity: ordered > 0 ? roundQty(Math.max(0, ordered - toQty(l.fulfilledQty))) : ordered,
      takeWith: l.fulfillment === "TAKE" || l.salesOrder.deliveryMethod === "TAKEN",
    };
  });
}

/**
 * Record allocate()'s shortfalls as InventoryException rows, one open row per
 * (order, product): a re-sync after a line edit updates the open row rather
 * than adding another, so the Oversold report counts each gap once. Then
 * settle the order's open rows -- any it now holds enough for close
 * themselves (lib/reports/oversold.ts). Overselling is allowed on purpose and
 * never blocks the sale; the gap must land somewhere back office can see it.
 */
export async function recordShortfalls(
  orderId: number,
  shortfalls: AllocationShortfall[],
  tx: PrismaTx,
): Promise<void> {
  for (const s of shortfalls) {
    const open = await tx.inventoryException.findFirst({
      where: { salesOrderId: orderId, productId: s.productId, resolvedAt: null },
      select: { id: true },
    });
    if (!open) {
      await tx.inventoryException.create({
        data: {
          salesOrderId: orderId,
          productId: s.productId,
          storeLocationId: s.storeLocationId,
          requested: s.requested,
          allocated: s.allocated,
          shortfall: s.shortfall,
        },
      });
    }
  }
  await settleShortfalls(tx, orderId);

  if (shortfalls.length > 0) {
    logger.warn("Inventory exception recorded -- sale proceeded oversold", {
      orderId,
      shortfalls,
    });
  }
}

/**
 * Resync for a line-item add/change/remove: per product, compare what the
 * order holds with what its active lines need, release only the excess and
 * allocate only the deficit.
 *
 * This was a full release-then-reallocate. That was safe while every committed
 * unit sat somewhere allocate() could find it again; it is not once a
 * commitment can be in transit to the order's store or staged for its
 * delivery, places allocate() does not draw from. Releasing those to re-commit
 * them would have handed the order's units back to free stock in a truck.
 *
 * Skips allocation (logging why) when the order's storeLocation string
 * can't be resolved to a StoreLocation id -- never throws, never blocks the
 * write that already happened.
 */
export async function resyncOrderAllocation(
  orderId: number,
  storeLocation: string | null | undefined,
  tx: PrismaTx,
): Promise<void> {
  const storeLocationId = await resolveOrderStoreLocationId(storeLocation, tx);
  if (storeLocationId == null) {
    logger.warn("Inventory resync skipped -- storeLocationId could not be resolved", {
      orderId,
      storeLocation,
    });
    return;
  }

  // Lock every product this resync will touch -- the ones the order holds now
  // and the ones its lines want -- once, in ascending order. Locking them in
  // two batches could take 9 then 2 while a sale takes 2 then 9: a deadlock.
  const lines = await getActiveOrderLines(orderId, tx);
  const held = await tx.inventoryPosition.groupBy({
    by: ["productId"],
    where: { salesOrderId: orderId },
    _sum: { quantity: true },
  });
  await lockProducts(tx, [...held.map((p) => p.productId), ...lines.map((l) => l.productId)]);

  const needed = new Map<number, number>();
  const takeWith = new Set<number>();
  for (const line of lines) {
    if (line.quantity > 0) {
      needed.set(line.productId, roundQty((needed.get(line.productId) ?? 0) + line.quantity));
      if (line.takeWith) takeWith.add(line.productId);
    }
  }
  const holding = new Map(held.map((h) => [h.productId, toQty(h._sum.quantity)]));

  const deficits: AllocationLine[] = [];
  for (const productId of new Set([...needed.keys(), ...holding.keys()])) {
    const difference = roundQty((needed.get(productId) ?? 0) - (holding.get(productId) ?? 0));
    if (difference < 0) await releaseUnits(orderId, productId, -difference, tx);
    else if (difference > 0) {
      deficits.push({
        productId,
        quantity: difference,
        storeLocationId,
        takeWith: takeWith.has(productId),
      });
    }
  }

  const result = await allocate(orderId, deficits, tx);
  await recordShortfalls(orderId, result.shortfalls, tx);
}
