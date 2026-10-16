// /app/__tests__/integration/stockImportSync.integration.test.ts
//
// Ledger plan phase 5: the POS stock import as a client of the ledger.
//
// The file states physical on-hand per (product, POS location). The import now
// plans one target per Holt place from the whole file (lib/inventory/
// importSync.ts) and applies it through the ledger: free stock becomes physical
// minus what is already committed to orders, so a sale's commitment survives
// the nightly file, and a second run of the same file writes nothing. A row at
// a POS location no place matches goes to the catch-all place at the store
// AppSettings names -- or, with none named, is reported and not written.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { allocate } from "@/lib/inventory/allocation";
import { toQty } from "@/lib/inventory/quantity";
import { runStockByItemImport } from "@/lib/adapters/ordorite/runners";
import { stockAt } from "../helpers/stock";

async function world(unmatchedStore: "set" | "unset" = "unset") {
  const store = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const back = await prisma.stockLocation.create({
    data: {
      storeLocationId: store.id,
      code: "BACK",
      name: "Back Stock",
      locationAliases: ["Mill Back", "Mill Annex"],
    },
  });
  const floor = await prisma.stockLocation.create({
    data: {
      storeLocationId: store.id,
      code: "FLOOR",
      name: "Floor",
      locationType: "FLOOR",
      locationAliases: ["Mill Floor"],
    },
  });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  await prisma.appSettings.create({
    data: {
      organizationId: 1,
      appName: "Test Co",
      unmatchedStockStoreLocationId: unmatchedStore === "set" ? store.id : null,
    },
  });
  invalidateAppSettingsCache();
  return { store, back, floor };
}

const fileRow = (stockId: number, location: string, onHand: number) => ({
  Stockid: String(stockId),
  "Part No": `P-${stockId}`,
  "Product Name": `Product ${stockId}`,
  "On Hand": String(onHand),
  "Cost Price": "10",
  SellingPrice: "25",
  Supplier: "Weaver",
  Department: "Textiles",
  Category: "Drapery",
  Stocklocation: location,
});

async function heldAt(stockId: number, stockLocationId: number) {
  const product = await prisma.product.findFirstOrThrow({ where: { externalId: stockId } });
  const rows = await prisma.inventoryPosition.findMany({
    where: { productId: product.id, stockLocationId },
  });
  return {
    free: rows.filter((r) => r.salesOrderId == null).reduce((s, r) => s + toQty(r.quantity), 0),
    committed: rows
      .filter((r) => r.salesOrderId != null)
      .reduce((s, r) => s + toQty(r.quantity), 0),
  };
}

describe("the stock import as a ledger client (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    invalidateAppSettingsCache();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("adds two POS names for one place, and a second run writes nothing", async () => {
    const { back } = await world();
    const file = [fileRow(1, "Mill Back", 3), fileRow(1, "Mill Annex", 2.5)];

    await runStockByItemImport(file, "import@example.test");
    expect(await heldAt(1, back.id)).toEqual({ free: 5.5, committed: 0 });

    const journalBefore = await prisma.stockMovement.count();
    const again = await runStockByItemImport(file, "import@example.test");
    expect(again.positionsUpserted).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(journalBefore);
  });

  it("a zero row empties its place, and a product the file drops at a covered place goes to zero", async () => {
    const { back, floor } = await world();
    await runStockByItemImport(
      [fileRow(1, "Mill Back", 4), fileRow(2, "Mill Back", 6), fileRow(3, "Mill Floor", 1)],
      null as unknown as string,
    );

    // Next day: product 1 counted at zero, product 2 not listed at all, the
    // floor not in the file. The floor keeps its unit; back stock is emptied.
    await runStockByItemImport([fileRow(1, "Mill Back", 0)], "import@example.test");

    expect(await heldAt(1, back.id)).toEqual({ free: 0, committed: 0 });
    expect(await heldAt(2, back.id)).toEqual({ free: 0, committed: 0 });
    expect(await heldAt(3, floor.id)).toEqual({ free: 1, committed: 0 });
  });

  it("never takes back stock a sale has committed", async () => {
    const { store, back } = await world();
    await runStockByItemImport([fileRow(1, "Mill Back", 5)], "import@example.test");
    const product = await prisma.product.findFirstOrThrow({ where: { externalId: 1 } });
    const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-1",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: store.name,
      },
    });
    await allocate(
      order.id,
      [{ productId: product.id, storeLocationId: store.id, quantity: 2 }],
      prisma,
    );

    // The POS still says 5 are there: 2 of them are the customer's.
    await runStockByItemImport([fileRow(1, "Mill Back", 5)], "import@example.test");
    expect(await heldAt(1, back.id)).toEqual({ free: 3, committed: 2 });

    // The POS now says 1: the commitment stands, free goes to zero, and the
    // import reports the place as short.
    const short = await runStockByItemImport([fileRow(1, "Mill Back", 1)], "import@example.test");
    expect(await heldAt(1, back.id)).toEqual({ free: 0, committed: 2 });
    expect(short.shortOfCommitted).toBe(1);
    expect(short.message).toContain("commitments kept");
  });

  it("with no unmatched-stock store set, an unmatched row is reported and not written", async () => {
    await world("unset");
    const result = await runStockByItemImport(
      [fileRow(1, "Somewhere Else", 3)],
      "import@example.test",
    );

    expect(result.unmatchedRowsNotWritten).toBe(1);
    expect(result.unmappedLocations).toEqual(["Somewhere Else"]);
    expect(result.message).toContain("NOT written");
    expect(await prisma.inventoryPosition.count()).toBe(0);
    expect(await prisma.stockLocation.count({ where: { code: "UNMATCHED" } })).toBe(0);
  });

  it("with one set, unmatched rows go to that store's catch-all, named in its note", async () => {
    const { store } = await world("set");
    await runStockByItemImport(
      [fileRow(1, "Annex", 1), fileRow(1, "Attic", 2)],
      "import@example.test",
    );

    const catchall = await prisma.stockLocation.findFirstOrThrow({ where: { code: "UNMATCHED" } });
    expect(catchall.storeLocationId).toBe(store.id);
    const row = await prisma.inventoryPosition.findFirstOrThrow({
      where: { stockLocationId: catchall.id },
    });
    expect(toQty(row.quantity)).toBe(3);
    expect(row.notes).toBe("Unmatched CSV location: Annex, Attic");
  });

  it("leaves stock the file says nothing about alone, even at its own store", async () => {
    const { store, floor } = await world();
    const product = await prisma.product.create({
      data: {
        productNumber: "NATIVE",
        name: "Native",
        vendor: { create: { name: "V", pricingModel: "FLAT" } },
        department: { create: { name: "D" } },
        category: { create: { name: "C", department: { create: { name: "D2" } } } },
      },
    });
    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: floor.id,
      quantity: 2,
    });

    await runStockByItemImport([fileRow(1, "Mill Back", 1)], "import@example.test");

    const row = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(toQty(row.quantity)).toBe(2);
  });
});
