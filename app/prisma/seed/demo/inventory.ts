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
import { postBackdatedMovement, postMovement } from "@/lib/inventory/ledger";
import type { MovementReason } from "@/lib/inventory/ledger";
import type { StoreSetup } from "./locations";
import type { SeedWindow } from "./config";

const SEED_ACTOR = "seed:demo";

export interface InventoryResult {
  positionsCreated: number;
  unitsOnHand: number;
  committedPositions: number;
  productsWithNoStock: number;
}

interface StockRow {
  productId: number;
  storeLocationId: number;
  stockLocationId: number;
  quantity: number;
  salesOrderId?: number;
  notes?: string;
}

/**
 * When a row of free stock came in. Stock with one date would leave Aged Stock
 * with one column and Inventory Value with nothing to say about any past day, so
 * the spread reaches every age bucket. The oldest slice is an opening balance on
 * the window's first day, which is also where the demo's journal starts.
 */
function arrivalOf(
  ageRng: Rng,
  window: SeedWindow,
): {
  reason: MovementReason;
  occurredAt: Date;
} {
  const roll = randInt(ageRng, 1, 100);
  if (roll <= 12) return { reason: "OPENING", occurredAt: window.start };
  let daysAgo: number;
  if (roll <= 22) daysAgo = randInt(ageRng, 366, 500);
  else if (roll <= 40) daysAgo = randInt(ageRng, 181, 365);
  else if (roll <= 65) daysAgo = randInt(ageRng, 91, 180);
  else daysAgo = randInt(ageRng, 1, 90);
  return {
    reason: "RECEIVE",
    occurredAt: new Date(window.now.getTime() - daysAgo * 86_400_000),
  };
}

/**
 * Through the single writer of InventoryPosition (lib/inventory/ledger.ts), like
 * every other path that puts stock somewhere: seeded stock arrives from outside
 * the books into its place. Free stock carries a history; committed stock is
 * today's staging and doesn't need one.
 */
async function postSeededStock(
  prisma: PrismaClient,
  row: StockRow,
  ageRng: Rng,
  window: SeedWindow,
): Promise<void> {
  const movement = {
    productId: row.productId,
    quantity: row.quantity,
    to: {
      storeLocationId: row.storeLocationId,
      stockLocationId: row.stockLocationId,
      salesOrderId: row.salesOrderId ?? null,
    },
    actor: SEED_ACTOR,
    note: row.notes,
  };
  if (row.salesOrderId) {
    await postMovement(prisma, { ...movement, reason: "OPENING" });
    return;
  }
  const { reason, occurredAt } = arrivalOf(ageRng, window);
  await postBackdatedMovement(prisma, { ...movement, reason }, occurredAt);
}

export async function seedInventory(
  prisma: PrismaClient,
  rng: Rng,
  products: CatalogProduct[],
  stores: StoreSetup[],
  warehouseStockLocationId: number,
  warehouseCommittedStockLocationId: number,
  warehouseStoreId: number,
  committedOrders: {
    id: number;
    storeLocationId: number | null;
    lineItems: { productId: number | null; orderedQuantity: unknown }[];
  }[],
  window: SeedWindow,
): Promise<InventoryResult> {
  const invRng = subRng(rng, "inventory");
  const result: InventoryResult = {
    positionsCreated: 0,
    unitsOnHand: 0,
    committedPositions: 0,
    productsWithNoStock: 0,
  };

  const rows: StockRow[] = [];

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
  // marks these as unavailable, not the location's name. The product is one of
  // the order's own lines, never more than it ordered: committed stock the
  // order has no line for is nothing a pull list, a pick or a delivery can
  // use (it picked any catalog product until 2026-10-16). One draw of each
  // kind per order either way, so the rest of the seed is unchanged.
  for (const order of committedOrders) {
    const line = pick(invRng, order.lineItems.length ? order.lineItems : [null]);
    const wanted = randInt(invRng, 1, 3);
    if (!line?.productId) continue;
    rows.push({
      productId: line.productId,
      storeLocationId: warehouseStoreId,
      stockLocationId: warehouseCommittedStockLocationId,
      quantity: Math.min(wanted, Number(line.orderedQuantity)),
      salesOrderId: order.id,
      notes: "Staged for delivery",
    });
    result.committedPositions++;
  }

  // A sub-stream takes one draw from its parent, so this one comes off invRng
  // after its last use: taken from the root it would shift every later module's data.
  const ageRng = subRng(invRng, "age");
  for (const row of rows) {
    await postSeededStock(prisma, row, ageRng, window);
    result.positionsCreated++;
    result.unitsOnHand += row.quantity;
  }

  return result;
}
