// /app/prisma/seed/demo/inventory.ts
//
// On-hand stock. Without it `InventoryPosition` is empty on a fresh clone, and
// with it empty the Inventory Health report renders nothing, the Buyers report
// shows no on-hand column, and the committed-stock split has no rows to split.
//
// The distribution is shaped to give those surfaces real signal rather than a
// uniform pile, because a uniform pile makes every report look correct and
// tests nothing:
//
//   FLOOR + BACK STOCK   the normal case, spread across both showrooms
//   WAREHOUSE BULK       depth on a subset, the "we hold this in quantity" case
//   COMMITTED STAGING    sold-but-not-delivered stock on the staging bay whose
//                        `holdsCommittedStock` flag is true, carrying the
//                        salesOrderId it is held for. This is the case
//                        lib/inventory/allocation.ts and buyersReport.ts must
//                        exclude from AVAILABLE stock, and the flag is how they
//                        should find it -- not by matching a location NAME
//                        against `Customer%`, which is one deployment's naming
//                        convention (docs/tenant-literal-sweep.md).
//   NEVER STOCKED        a slice of products left with no position at all, so
//                        "dead stock" and "never sold" are distinguishable
//                        rather than every product looking alike.
//
// Deliberately NOT modelled: uncosted units. Inventory Health buckets stock
// whose product has a null or zero baseCost, and this catalog costs every
// product, so that bucket reads zero. Seeding a fake uncosted product to make a
// KPI non-empty would be inventing a data-quality problem the demo does not
// have -- the report correctly showing zero is the honest outcome.

import type { PrismaClient } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randInt, subRng } from "./rng";
import type { CatalogProduct } from "./catalog";
import type { StoreSetup } from "./locations";

const SEED_ACTOR = "seed:demo";

export interface InventoryResult {
  positionsCreated: number;
  unitsOnHand: number;
  committedPositions: number;
  productsWithNoStock: number;
}

export async function seedInventory(
  prisma: PrismaClient,
  rng: Rng,
  products: CatalogProduct[],
  stores: StoreSetup[],
  warehouseStockLocationId: number,
  warehouseCommittedStockLocationId: number,
  warehouseStoreId: number,
  committedOrders: { id: number; storeLocationId: number | null }[],
): Promise<InventoryResult> {
  const invRng = subRng(rng, "inventory");
  const result: InventoryResult = {
    positionsCreated: 0,
    unitsOnHand: 0,
    committedPositions: 0,
    productsWithNoStock: 0,
  };

  const rows: {
    productId: number;
    storeLocationId: number;
    stockLocationId: number;
    quantity: number;
    salesOrderId?: number;
    notes?: string;
  }[] = [];

  for (const product of products) {
    // ~15% of the catalog is never stocked: special-order or discontinued.
    // Keeps "no position" distinguishable from "position with zero quantity".
    if (randInt(invRng, 1, 100) <= 15) {
      result.productsWithNoStock++;
      continue;
    }

    // Showroom stock: most products sit on a floor, some also in back stock.
    const store = pick(invRng, stores);
    rows.push({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: store.floorStockLocationId,
      quantity: randInt(invRng, 1, 6),
    });
    if (randInt(invRng, 1, 100) <= 40) {
      rows.push({
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: store.backStockLocationId,
        quantity: randInt(invRng, 1, 4),
      });
    }

    // Warehouse depth on a third of the catalog.
    if (randInt(invRng, 1, 100) <= 33) {
      rows.push({
        productId: product.id,
        storeLocationId: warehouseStoreId,
        stockLocationId: warehouseStockLocationId,
        quantity: randInt(invRng, 2, 20),
      });
    }
  }

  // Committed stock: sold goods staged for delivery, held against the order
  // they belong to. The `holdsCommittedStock` flag on the staging bay is what
  // marks these as unavailable, not the location's name.
  for (const order of committedOrders) {
    const product = pick(invRng, products);
    rows.push({
      productId: product.id,
      storeLocationId: warehouseStoreId,
      stockLocationId: warehouseCommittedStockLocationId,
      quantity: randInt(invRng, 1, 3),
      salesOrderId: order.id,
      notes: "Staged for delivery",
    });
    result.committedPositions++;
  }

  for (const row of rows) {
    await prisma.inventoryPosition.create({ data: { ...row, createdBy: SEED_ACTOR } });
    result.positionsCreated++;
    result.unitsOnHand += row.quantity;
  }

  return result;
}
