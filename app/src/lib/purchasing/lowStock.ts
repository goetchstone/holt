// /app/src/lib/purchasing/lowStock.ts
//
// GAP-14: what is below its reorder point, store by store. Which rows count
// (rule 2), stated once here:
//
//   free stock   freePositionWhere, what the register and the allocator call
//                free: nothing committed to an order, set aside or on display.
//   on order     what's left to come on stock POs shipping to this store. Open
//                ones only (SUBMITTED, CONFIRMED, RECEIVED_PARTIAL), and not a
//                line ordered for a customer, or a return to the vendor: that
//                stock is spoken for. A PO with no ship-to counts at no store.
//   on a draft   the same, on a DRAFT: being ordered, not ordered.
//   left out     a product that's discontinued or inactive, or whose category
//                keeps no stock (GAP-21), and an inactive store. Its reorder
//                point stays, and comes back with the product.

import type { Prisma } from "@prisma/client";
import { freePositionWhere } from "@/lib/inventory/allocation";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { STOCKED_SELECT, isStockedProduct } from "@/lib/inventory/stocked";
import { type LowStockRow, shortfall } from "./lowStockShared";

type Db = Pick<
  Prisma.TransactionClient,
  "reorderPoint" | "inventoryPosition" | "purchaseOrderItem"
>;

const key = (productId: number, storeLocationId: number) => `${productId}:${storeLocationId}`;

function addTo(map: Map<string, number>, k: string, quantity: number) {
  map.set(k, roundQty((map.get(k) ?? 0) + quantity));
}

/** Stock still to come per product and store: { onOrder, onDraft }. */
async function comingIn(db: Db, productIds: number[], storeIds: number[]) {
  const lines = await db.purchaseOrderItem.findMany({
    where: {
      productId: { in: productIds },
      orderLineItemId: null,
      purchaseOrder: {
        status: { in: ["DRAFT", "SUBMITTED", "CONFIRMED", "RECEIVED_PARTIAL"] },
        isReturn: false,
        salesOrderId: null,
        shipToLocationId: { in: storeIds },
      },
    },
    select: {
      productId: true,
      orderedQuantity: true,
      purchaseOrder: { select: { status: true, shipToLocationId: true } },
      receivingRecords: { select: { quantityReceived: true } },
    },
  });
  const onOrder = new Map<string, number>();
  const onDraft = new Map<string, number>();
  for (const line of lines) {
    const received = line.receivingRecords.reduce((sum, r) => sum + toQty(r.quantityReceived), 0);
    const left = toQty(line.orderedQuantity) - received;
    const store = line.purchaseOrder.shipToLocationId;
    if (left <= 0 || line.productId == null || store == null) continue;
    addTo(
      line.purchaseOrder.status === "DRAFT" ? onDraft : onOrder,
      key(line.productId, store),
      left,
    );
  }
  return { onOrder, onDraft };
}

export async function lowStockRows(
  db: Db,
  filter: { storeLocationId?: number; vendorId?: number } = {},
): Promise<LowStockRow[]> {
  const points = await db.reorderPoint.findMany({
    where: {
      ...(filter.storeLocationId ? { storeLocationId: filter.storeLocationId } : {}),
      storeLocation: { isActive: true },
      product: {
        isActive: true,
        isDiscontinued: false,
        ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
      },
    },
    select: {
      id: true,
      productId: true,
      storeLocationId: true,
      minQuantity: true,
      orderQuantity: true,
      storeLocation: { select: { name: true } },
      product: {
        select: {
          productNumber: true,
          name: true,
          vendorId: true,
          vendor: { select: { name: true } },
          ...STOCKED_SELECT,
        },
      },
    },
  });
  const stocked = points.filter((p) => isStockedProduct(p.product));
  if (stocked.length === 0) return [];

  const productIds = [...new Set(stocked.map((p) => p.productId))];
  const storeIds = [...new Set(stocked.map((p) => p.storeLocationId))];
  const positions = await db.inventoryPosition.groupBy({
    by: ["productId", "storeLocationId"],
    where: {
      ...freePositionWhere(),
      productId: { in: productIds },
      storeLocationId: { in: storeIds },
    },
    _sum: { quantity: true },
  });
  const free = new Map(
    positions.map((p) => [key(p.productId, p.storeLocationId), toQty(p._sum.quantity)]),
  );
  const { onOrder, onDraft } = await comingIn(db, productIds, storeIds);

  const rows: LowStockRow[] = [];
  for (const p of stocked) {
    const k = key(p.productId, p.storeLocationId);
    const quantities = {
      minQuantity: toQty(p.minQuantity),
      orderQuantity: p.orderQuantity == null ? null : toQty(p.orderQuantity),
      free: free.get(k) ?? 0,
      onOrder: onOrder.get(k) ?? 0,
      onDraft: onDraft.get(k) ?? 0,
    };
    const short = shortfall(quantities);
    if (!short) continue;
    rows.push({
      reorderPointId: p.id,
      productId: p.productId,
      productNumber: p.product.productNumber,
      productName: p.product.name,
      vendorId: p.product.vendorId,
      vendor: p.product.vendor?.name ?? null,
      storeLocationId: p.storeLocationId,
      store: p.storeLocation.name,
      ...quantities,
      ...short,
    });
  }
  // By store, then furthest below its level.
  return rows.sort(
    (a, b) =>
      a.store.localeCompare(b.store) ||
      b.shortBy - a.shortBy ||
      a.productName.localeCompare(b.productName),
  );
}
