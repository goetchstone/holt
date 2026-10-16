// /app/__tests__/helpers/stock.ts
//
// Fixture stock for integration tests, put in place the way production puts it
// there: through lib/inventory/ledger.ts, so it has a journal row behind it.
//
// Every integration test ends with a drift check (jest.integration.afterEach.ts):
// the balance at every place must equal the journal's sum. A fixture written
// with `prisma.inventoryPosition.create` has no journal row and fails that
// check, which is the point -- production code cannot write stock that way
// either (stockWriterTripwire.test.ts).

import type { InventoryPosition } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { placeWhere, postMovement, setPlaceQuantity } from "@/lib/inventory/ledger";
import type { PrismaTx } from "@/lib/inventory/ledger";
import { placeAt } from "@/lib/inventory/places";

export interface StockFixture {
  productId: number;
  storeLocationId: number;
  /** Omitted or null: the store's receiving place, as production would choose. */
  stockLocationId?: number | null;
  salesOrderId?: number | null;
  quantity: number;
  notes?: string | null;
}

/**
 * Put `quantity` units at a place as opening stock, and return the place's row.
 * Stock already at the same place is added to, not duplicated -- one row per
 * place, as the ledger keeps it.
 */
export async function stockAt(
  fixture: StockFixture,
  db: PrismaTx = prisma,
): Promise<InventoryPosition> {
  const place = await placeAt(db, fixture);
  await postMovement(db, {
    productId: fixture.productId,
    quantity: fixture.quantity,
    to: place,
    reason: "OPENING",
    actor: "test",
    note: fixture.notes,
  });
  return db.inventoryPosition.findFirstOrThrow({
    where: placeWhere(fixture.productId, place),
    orderBy: { id: "asc" },
  });
}

/** Make an existing position's place hold exactly `quantity`, by hand. */
export async function setStock(
  row: Pick<
    InventoryPosition,
    "productId" | "storeLocationId" | "stockLocationId" | "salesOrderId"
  >,
  quantity: number,
  db: PrismaTx = prisma,
): Promise<void> {
  await setPlaceQuantity(db, {
    productId: row.productId,
    place: {
      storeLocationId: row.storeLocationId,
      stockLocationId: row.stockLocationId,
      salesOrderId: row.salesOrderId,
    },
    target: quantity,
    reason: "ADJUST",
    actor: "test",
  });
}
