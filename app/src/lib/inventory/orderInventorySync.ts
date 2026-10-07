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
import { allocate, release } from "@/lib/inventory/allocation";
import { buildLocationMap } from "@/lib/storeLocationResolver";
import { logger } from "@/lib/logger";

export interface OrderLineForAllocation {
  productId: number;
  /** May be negative for a return line -- allocate()/consume() both skip
   *  non-positive quantities, so callers can pass this straight through. */
  quantity: number;
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
 * Shape doubles as both AllocationLine (add a storeLocationId) and
 * ConsumptionLine (used as-is) -- see allocation.ts's interfaces.
 */
export async function getActiveOrderLines(
  orderId: number,
  tx: PrismaTx,
): Promise<OrderLineForAllocation[]> {
  const lines = await tx.orderLineItem.findMany({
    where: { salesOrderId: orderId, lineItemStatus: "ACTIVE", productId: { not: null } },
    select: { productId: true, orderedQuantity: true },
  });
  return lines.map((l) => ({
    productId: l.productId as number,
    quantity: Number(l.orderedQuantity),
  }));
}

/**
 * Record allocate()'s shortfalls as durable InventoryException rows. See
 * that function's file header: overselling is allowed on purpose and never
 * blocks the sale, but the gap must land somewhere back office can see and
 * work it. No-ops on an empty list so callers can call this unconditionally.
 */
export async function recordShortfalls(
  orderId: number,
  shortfalls: AllocationShortfall[],
  tx: PrismaTx,
): Promise<void> {
  if (shortfalls.length === 0) return;

  await tx.inventoryException.createMany({
    data: shortfalls.map((s) => ({
      salesOrderId: orderId,
      productId: s.productId,
      storeLocationId: s.storeLocationId,
      requested: s.requested,
      allocated: s.allocated,
      shortfall: s.shortfall,
    })),
  });

  logger.warn("Inventory exception recorded -- sale proceeded oversold", {
    orderId,
    shortfalls,
  });
}

/**
 * Full resync for a line-item add/change/remove: release everything the
 * order currently has committed, then re-allocate against its current
 * active lines. See allocation.ts's `release()` doc comment for why this is
 * a full resync rather than per-line delta math -- a partial-release
 * implementation is where split/merged positions go wrong.
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

  await release(orderId, tx);

  const lines = await getActiveOrderLines(orderId, tx);
  const allocationLines: AllocationLine[] = lines.map((l) => ({ ...l, storeLocationId }));
  const result = await allocate(orderId, allocationLines, tx);
  await recordShortfalls(orderId, result.shortfalls, tx);
}
