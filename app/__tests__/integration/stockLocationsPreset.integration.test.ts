// /app/__tests__/integration/stockLocationsPreset.integration.test.ts
//
// The stock-locations preset kind against real Postgres: a deployment's layout
// of places inside its stores, kept in a file and applied declaratively.
// Rule 63 throughout -- apply computes a diff, a second apply writes nothing,
// unknown stores fail closed, and a place dropped from the file is deactivated,
// never deleted, because it can hold stock.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { stockAt } from "../helpers/stock";
import { applyPreset } from "@/lib/config/applyPreset";
import { loadDbConfigState } from "@/lib/config/dbConfigState";
import { stockLocationsPresetSchema, type StockLocationsPreset } from "@/lib/config/presetSchema";

const opts = { source: "test:integration", prisma };

function layout(stores: unknown[], name = "stock-locations"): StockLocationsPreset {
  return stockLocationsPresetSchema.parse({ kind: "stock-locations", name, stores });
}

async function seedStores() {
  const a = await prisma.storeLocation.create({
    data: { name: "Harbor Showroom", code: "HS", type: "STORE" },
  });
  const w = await prisma.storeLocation.create({
    data: { name: "Ridge Warehouse", code: "RW", type: "WAREHOUSE" },
  });
  return { a, w };
}

const placesOf = (storeLocationId: number) =>
  prisma.stockLocation.findMany({ where: { storeLocationId }, orderBy: { code: "asc" } });

const baseLayout = () =>
  layout([
    {
      storeLocation: "Harbor Showroom",
      locations: [
        { code: "FLR", name: "Sales Floor", locationType: "FLOOR", squareFootage: 6000 },
        { code: "BACK", name: "Back Stock", aliases: ["HS Back"] },
      ],
    },
    {
      storeLocation: "Ridge Warehouse",
      locations: [
        // Listed after the place inside it: parents are set once every place
        // in the file exists.
        {
          code: "01-03-01-01",
          name: "Stock Sofas",
          inside: "NORTH",
          aliases: ["RW Sofas"],
        },
        { code: "NORTH", name: "North Barn", locationType: "GROUP" },
        { code: "HOLD", name: "Customer Holding", holdsCommittedStock: true },
      ],
    },
  ]);

describe("stock-locations preset", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("creates the listed places with exactly the fields the file states", async () => {
    const { a, w } = await seedStores();
    const result = await applyPreset(baseLayout(), opts);
    expect(result.action).toBe("APPLIED");
    expect(result.changes).toEqual({ created: 5, updated: 0, deleted: 0 });

    const floor = (await placesOf(a.id)).find((p) => p.code === "FLR")!;
    expect(floor).toMatchObject({
      name: "Sales Floor",
      locationType: "FLOOR",
      squareFootage: 6000,
    });
    const north = (await placesOf(w.id)).find((p) => p.code === "NORTH")!;
    expect(north).toMatchObject({ locationType: "GROUP", parentId: null });
    const sofas = (await placesOf(w.id)).find((p) => p.code === "01-03-01-01")!;
    expect(sofas).toMatchObject({
      parentId: north.id,
      locationAliases: ["RW Sofas"],
      holdsCommittedStock: false,
      isActive: true,
    });
    expect((await placesOf(w.id)).find((p) => p.code === "HOLD")!.holdsCommittedStock).toBe(true);
  });

  it("a second apply of the same file writes nothing (rule 63)", async () => {
    await seedStores();
    await applyPreset(baseLayout(), opts);
    const again = await applyPreset(baseLayout(), opts);
    expect(again.action).toBe("UNCHANGED");
    expect(again.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  it("a dry run reports the diff and writes nothing", async () => {
    const { a } = await seedStores();
    const dry = await applyPreset(baseLayout(), { ...opts, dryRun: true });
    expect(dry.changes.created).toBe(5);
    expect(await placesOf(a.id)).toHaveLength(0);
    expect(await prisma.configChangeLog.count()).toBe(0);
  });

  it("changing one field updates only that place", async () => {
    const { a } = await seedStores();
    await applyPreset(baseLayout(), opts);
    const edited = baseLayout();
    edited.stores[0].locations[0].squareFootage = 6500;
    const result = await applyPreset(edited, opts);
    expect(result.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(result.messages).toEqual(["Harbor Showroom / FLR: updated (squareFootage)"]);
    expect((await placesOf(a.id)).find((p) => p.code === "FLR")!.squareFootage).toBe(6500);
  });

  it("a place dropped from the file is deactivated and loses its aliases, never deleted", async () => {
    const { a } = await seedStores();
    await applyPreset(baseLayout(), opts);
    const back = (await placesOf(a.id)).find((p) => p.code === "BACK")!;
    // It holds stock: deleting the place would orphan this row.
    const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
    const dept = await prisma.department.create({ data: { name: "D" } });
    const cat = await prisma.category.create({ data: { name: "C", departmentId: dept.id } });
    const product = await prisma.product.create({
      data: {
        productNumber: "P",
        name: "P",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    await stockAt({
      productId: product.id,
      storeLocationId: a.id,
      stockLocationId: back.id,
      quantity: 2,
    });

    const trimmed = baseLayout();
    trimmed.stores[0].locations = trimmed.stores[0].locations.filter((l) => l.code !== "BACK");
    const result = await applyPreset(trimmed, opts);
    expect(result.changes).toEqual({ created: 0, updated: 0, deleted: 1 });

    const after = await prisma.stockLocation.findUniqueOrThrow({ where: { id: back.id } });
    expect(after).toMatchObject({ isActive: false, locationAliases: [] });
    expect(await prisma.inventoryPosition.count({ where: { stockLocationId: back.id } })).toBe(1);

    // Listing it again brings it back, aliases and all.
    const restored = await applyPreset(baseLayout(), opts);
    expect(restored.changes.updated).toBe(1);
    expect(await prisma.stockLocation.findUniqueOrThrow({ where: { id: back.id } })).toMatchObject({
      isActive: true,
      locationAliases: ["HS Back"],
    });
  });

  it("leaves alone a place the preset never listed (made at Warehouse > Locations)", async () => {
    const { a } = await seedStores();
    const handMade = await prisma.stockLocation.create({
      data: { storeLocationId: a.id, code: "ANNEX", name: "Annex" },
    });
    await applyPreset(baseLayout(), opts);
    await applyPreset(baseLayout(), opts);
    expect(
      await prisma.stockLocation.findUniqueOrThrow({ where: { id: handMade.id } }),
    ).toMatchObject({
      isActive: true,
      name: "Annex",
    });
  });

  it("fails closed on a store that does not exist, and writes nothing", async () => {
    await seedStores();
    const result = await applyPreset(
      layout([{ storeLocation: "Nowhere", locations: [{ code: "X", name: "X" }] }]),
      opts,
    );
    expect(result.action).toBe("FAILED");
    expect(result.messages[0]).toContain("unknown store(s): Nowhere");
    expect(await prisma.stockLocation.count()).toBe(0);
  });

  it("refuses a store whose layout another preset already owns", async () => {
    await seedStores();
    await applyPreset(baseLayout(), opts);
    const rival = layout(
      [{ storeLocation: "Harbor Showroom", locations: [{ code: "FLR", name: "Floor" }] }],
      "rival-layout",
    );
    const result = await applyPreset(rival, opts);
    expect(result.action).toBe("FAILED");
    expect(result.messages[0]).toContain(
      'already laid out by stock-locations preset "stock-locations"',
    );
  });

  it("refuses an alias that already names a place outside the preset", async () => {
    const { w } = await seedStores();
    await prisma.stockLocation.create({
      data: { storeLocationId: w.id, code: "OLD", name: "Old Bay", locationAliases: ["HS Back"] },
    });
    const result = await applyPreset(baseLayout(), opts);
    expect(result.action).toBe("FAILED");
    expect(result.messages[0]).toContain('alias "HS Back"');
    expect(await prisma.stockLocation.count()).toBe(1);
  });

  it("moves a place by its inside, and taking inside away puts it at the top", async () => {
    const { w } = await seedStores();
    await applyPreset(baseLayout(), opts);
    const flat = baseLayout();
    flat.stores[1].locations = flat.stores[1].locations.map((l) =>
      l.code === "01-03-01-01" ? { ...l, inside: undefined } : l,
    );
    const result = await applyPreset(flat, opts);
    expect(result.messages).toEqual(["Ridge Warehouse / 01-03-01-01: updated (inside)"]);
    const sofas = (await placesOf(w.id)).find((p) => p.code === "01-03-01-01")!;
    expect(sofas.parentId).toBeNull();
    expect((await applyPreset(flat, opts)).action).toBe("UNCHANGED");
  });

  it("refuses to make a group of a place still holding stock, and writes nothing (rule 42)", async () => {
    const { a } = await seedStores();
    await applyPreset(baseLayout(), opts);
    const back = (await placesOf(a.id)).find((p) => p.code === "BACK")!;
    const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
    const dept = await prisma.department.create({ data: { name: "D" } });
    const cat = await prisma.category.create({ data: { name: "C", departmentId: dept.id } });
    const product = await prisma.product.create({
      data: {
        productNumber: "P",
        name: "P",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    await stockAt({
      productId: product.id,
      storeLocationId: a.id,
      stockLocationId: back.id,
      quantity: 2,
    });

    const grouped = baseLayout();
    grouped.stores[0].locations = grouped.stores[0].locations.map((l) =>
      l.code === "BACK" ? { ...l, locationType: "GROUP" as const, name: "Back (renamed)" } : l,
    );
    const result = await applyPreset(grouped, opts);
    expect(result.action).toBe("FAILED");
    expect(result.messages).toEqual([
      "Harbor Showroom / BACK: This place holds stock; move it out before making the place a group.",
    ]);
    expect(await prisma.stockLocation.findUniqueOrThrow({ where: { id: back.id } })).toMatchObject({
      locationType: "STOCK",
      name: "Back Stock",
    });
  });

  it("exports a place inside an inactive place at the top, so the file never names a place it leaves out", async () => {
    const { w } = await seedStores();
    await applyPreset(baseLayout(), opts);
    const north = (await placesOf(w.id)).find((p) => p.code === "NORTH")!;
    await prisma.stockLocation.update({ where: { id: north.id }, data: { isActive: false } });

    const { bundle } = await loadDbConfigState(prisma);
    const exported = bundle.presets.find(
      (p) => p.kind === "stock-locations",
    ) as StockLocationsPreset;
    const ridge = exported.stores.find((s) => s.storeLocation === "Ridge Warehouse")!;
    expect(ridge.locations.find((l) => l.code === "01-03-01-01")?.inside).toBeUndefined();
    expect(stockLocationsPresetSchema.safeParse(exported).success).toBe(true);
  });

  it("a database export, applied back, changes nothing", async () => {
    await seedStores();
    await applyPreset(baseLayout(), opts);
    const { bundle } = await loadDbConfigState(prisma);
    const exported = bundle.presets.filter((p) => p.kind === "stock-locations");
    expect(exported.map((p) => p.name)).toEqual(["stock-locations"]);
    for (const preset of exported) {
      const result = await applyPreset(preset, opts);
      expect(result.action).toBe("UNCHANGED");
    }
  });
});
