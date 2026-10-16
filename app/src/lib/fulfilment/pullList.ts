// /app/src/lib/fulfilment/pullList.ts
//
// The pull list (ledger plan phase 9): every unit an order needs that is not
// yet where it leaves from, and where it is now. Derived, never stored.
//
// One builder for everything that used to build pick lists its own way -- a
// delivery run's pick list (lib/deliveryService.ts) and an order's
// (pages/api/dispatch/pick-lists): they had diverged, and both listed
// cancelled and replaced lines (rule 33). Here:
//
//   - only the order's active lines count, and only what is still to fulfil
//     (ordered less fulfilledQty);
//   - each row is a unit the order already holds -- its committed stock, at the
//     place it sits -- so a pick list never sends someone for another
//     customer's sofa;
//   - units already where the order leaves from count as pulled: for a pickup,
//     the pickup store's pickup place; for a delivery, any STAGING place (the
//     loading bay) until runs carry a truck place of their own;
//   - what the order needs but holds nothing of is a row with no place, so the
//     shortfall shows instead of vanishing;
//   - a unit committed at a different store than the order's is flagged: it
//     needs a store-to-store transfer before it can be pulled.

import type { Prisma } from "@prisma/client";
import { pickupPlaceId } from "@/lib/inventory/places";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import type { PrismaTx } from "@/lib/inventory/ledger";

export interface PullRow {
  salesOrderId: number;
  orderLineItemId: number | null;
  productId: number;
  quantity: number;
  /** Where the units are now; null when the order holds none of them. */
  fromStoreLocationId: number | null;
  fromStockLocationId: number | null;
  /** The units are at another store than the order's: transfer them first. */
  crossSite: boolean;
}

export interface PullListResult {
  rows: PullRow[];
  /** Messages for the person pulling: a pickup store with no pickup place, and so on. */
  notes: string[];
}

type Db = PrismaTx | Prisma.TransactionClient;

async function ordersOf(
  db: Db,
  scope: { deliveryRunId: number } | { salesOrderId: number },
): Promise<number[]> {
  if ("salesOrderId" in scope) return [scope.salesOrderId];
  // A return pickup is a stop that brings goods back, not one that takes them.
  const stops = await db.deliveryStop.findMany({
    where: {
      deliveryRunId: scope.deliveryRunId,
      serviceAppointment: { type: { not: "RETURN_PICKUP" } },
    },
    orderBy: { stopOrder: "asc" },
    select: { serviceAppointment: { select: { salesOrderId: true } } },
  });
  return Array.from(new Set(stops.map((s) => s.serviceAppointment.salesOrderId)));
}

export async function buildPullList(
  db: Db,
  scope: { deliveryRunId: number } | { salesOrderId: number },
): Promise<PullListResult> {
  const rows: PullRow[] = [];
  const notes: string[] = [];

  for (const salesOrderId of await ordersOf(db, scope)) {
    const order = await db.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: {
        orderno: true,
        storeLocationId: true,
        deliveryMethod: true,
        pickupLocationId: true,
        lineItems: {
          where: { lineItemStatus: "ACTIVE", productId: { not: null } },
          select: { id: true, productId: true, orderedQuantity: true, fulfilledQty: true },
          orderBy: { lineNumber: "asc" },
        },
      },
    });
    if (!order) continue;

    // Where this order leaves from: units already there are pulled.
    let pickupPlace: number | null = null;
    if (order.deliveryMethod === "PICKUP") {
      const pickupStore = order.pickupLocationId ?? order.storeLocationId;
      pickupPlace = pickupStore ? await pickupPlaceId(db, pickupStore) : null;
      if (pickupStore && pickupPlace == null) {
        notes.push(
          `${order.orderno}: set a pickup place for its pickup store (Warehouse > Locations).`,
        );
      }
    }

    const held = await db.inventoryPosition.findMany({
      where: { salesOrderId },
      include: { stockLocation: { select: { locationType: true } } },
      orderBy: { id: "asc" },
    });
    // Per product: the order's committed stock still to pull, place by place,
    // and how much has already reached where it leaves from -- that covers
    // the first lines' needs before anything is pulled for them.
    const toPull = new Map<
      number,
      { storeLocationId: number; stockLocationId: number; left: number }[]
    >();
    const alreadyPulled = new Map<number, number>();
    for (const row of held) {
      const pulled =
        row.stockLocationId === pickupPlace ||
        (order.deliveryMethod !== "PICKUP" && row.stockLocation.locationType === "STAGING");
      if (pulled) {
        alreadyPulled.set(
          row.productId,
          roundQty((alreadyPulled.get(row.productId) ?? 0) + toQty(row.quantity)),
        );
        continue;
      }
      const list = toPull.get(row.productId) ?? [];
      list.push({
        storeLocationId: row.storeLocationId,
        stockLocationId: row.stockLocationId,
        left: toQty(row.quantity),
      });
      toPull.set(row.productId, list);
    }

    for (const line of order.lineItems) {
      const productId = line.productId!;
      let need = roundQty(toQty(line.orderedQuantity) - toQty(line.fulfilledQty));
      const covered = Math.min(need, alreadyPulled.get(productId) ?? 0);
      need = roundQty(need - covered);
      alreadyPulled.set(productId, roundQty((alreadyPulled.get(productId) ?? 0) - covered));

      for (const place of toPull.get(productId) ?? []) {
        if (!(need > 0)) break;
        if (!(place.left > 0)) continue;
        const take = roundQty(Math.min(need, place.left));
        rows.push({
          salesOrderId,
          orderLineItemId: line.id,
          productId,
          quantity: take,
          fromStoreLocationId: place.storeLocationId,
          fromStockLocationId: place.stockLocationId,
          crossSite:
            order.storeLocationId != null && place.storeLocationId !== order.storeLocationId,
        });
        place.left = roundQty(place.left - take);
        need = roundQty(need - take);
      }
      if (need > 0) {
        rows.push({
          salesOrderId,
          orderLineItemId: line.id,
          productId,
          quantity: need,
          fromStoreLocationId: null,
          fromStockLocationId: null,
          crossSite: false,
        });
      }
    }
  }
  return { rows, notes };
}
