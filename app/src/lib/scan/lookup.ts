// /app/src/lib/scan/lookup.ts
//
// What a handheld shows for a scan (ledger plan phase 15): for a product,
// every place it sits and how much of it is free or committed; for a place,
// every product in it and in the places inside it. Read straight from the
// balance (InventoryPosition), the same rows the allocator draws on.

import type { Prisma, PrismaClient } from "@prisma/client";
import { descendantIds, placePath } from "@/lib/inventory/placeTree";
import { toQty, roundQty } from "@/lib/inventory/quantity";

type Db = PrismaClient | Prisma.TransactionClient;

export interface StockLine {
  storeName: string;
  placeId: number;
  placePath: string;
  locationType: string;
  productId: number;
  productNumber: string;
  productName: string;
  free: number;
  committed: number;
}

async function pathsFor(db: Db, storeIds: number[]) {
  const places = await db.stockLocation.findMany({
    where: { storeLocationId: { in: storeIds } },
    select: { id: true, parentId: true, name: true, locationType: true },
  });
  return { places, path: (id: number) => placePath(places, id) };
}

function fold(
  rows: {
    stockLocationId: number;
    salesOrderId: number | null;
    quantity: Prisma.Decimal;
    storeLocation: { name: string };
    product: { id: number; productNumber: string; name: string };
  }[],
  path: (id: number) => string,
  typeOf: (id: number) => string,
): StockLine[] {
  const lines = new Map<string, StockLine>();
  for (const r of rows) {
    const key = `${r.stockLocationId}:${r.product.id}`;
    const line = lines.get(key) ?? {
      storeName: r.storeLocation.name,
      placeId: r.stockLocationId,
      placePath: path(r.stockLocationId),
      locationType: typeOf(r.stockLocationId),
      productId: r.product.id,
      productNumber: r.product.productNumber,
      productName: r.product.name,
      free: 0,
      committed: 0,
    };
    const n = toQty(r.quantity);
    if (r.salesOrderId == null) line.free = roundQty(line.free + n);
    else line.committed = roundQty(line.committed + n);
    lines.set(key, line);
  }
  return [...lines.values()].sort(
    (a, b) =>
      a.storeName.localeCompare(b.storeName) ||
      a.placePath.localeCompare(b.placePath) ||
      a.productName.localeCompare(b.productName),
  );
}

const ROW_SELECT = {
  stockLocationId: true,
  salesOrderId: true,
  quantity: true,
  storeLocation: { select: { name: true } },
  product: { select: { id: true, productNumber: true, name: true } },
} as const;

/** Every place a product sits, free and committed. */
export async function productStock(db: Db, productId: number): Promise<StockLine[]> {
  const rows = await db.inventoryPosition.findMany({
    where: { productId },
    select: { ...ROW_SELECT, storeLocationId: true },
  });
  const { places, path } = await pathsFor(db, [...new Set(rows.map((r) => r.storeLocationId))]);
  const types = new Map(places.map((p) => [p.id, p.locationType]));
  return fold(rows, path, (id) => types.get(id) ?? "");
}

/** Everything in a place and in the places inside it. */
export async function placeContents(
  db: Db,
  place: { id: number; storeLocationId: number },
): Promise<StockLine[]> {
  const { places, path } = await pathsFor(db, [place.storeLocationId]);
  const ids = [place.id, ...descendantIds(places, place.id)];
  const rows = await db.inventoryPosition.findMany({
    where: { stockLocationId: { in: ids } },
    select: ROW_SELECT,
  });
  const types = new Map(places.map((p) => [p.id, p.locationType]));
  return fold(rows, path, (id) => types.get(id) ?? "");
}
