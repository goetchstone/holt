// app/prisma/seed/demo/locations.ts
//
// StoreLocations (two showrooms + one warehouse), their StockLocations, and
// the Registers each showroom runs its POS on.
//
// `taxDistrictId` (optional) wires every seeded store to the CT district
// seedAccounting() creates -- this seed's whole deployment is Connecticut,
// so every store shares the one district. A real multi-state deployment
// would set each store's own district per docs/domains/config-presets.md
// or the admin UI; this seed has no second state to demonstrate that with.
// Passing it (or not) is a fresh `npm run setup`'s only lever for keeping
// resolveTaxRate.ts's "store's district" tier populated -- leaving it unset
// still works (falls through to AppSettings.defaultTaxDistrictId, wired in
// index.ts), but setting it here exercises the more common real-world path.

import type { PrismaClient } from "@prisma/client";

const SEED_ACTOR = "seed:demo";

export interface StoreSetup {
  id: number;
  name: string;
  code: string;
  floorStockLocationId: number;
  backStockLocationId: number;
  registerIds: number[];
}

export interface LocationsSetup {
  stores: StoreSetup[];
  warehouseStockLocationId: number;
  /** The warehouse bay flagged `holdsCommittedStock` -- on hand, already sold. */
  warehouseCommittedStockLocationId: number;
}

const STORE_DEFS = [
  {
    name: "Millbrook Falls Showroom",
    code: "MBF",
    address: "412 Foundry Row",
    city: "Millbrook Falls",
    state: "CT",
    zip: "06437",
  },
  {
    name: "Wintergreen Harbor Showroom",
    code: "WGH",
    address: "88 Harborview Ave",
    city: "Wintergreen Harbor",
    state: "CT",
    zip: "06498",
  },
] as const;

export async function seedLocations(
  prisma: PrismaClient,
  taxDistrictId?: number,
): Promise<LocationsSetup> {
  const warehouse = await prisma.storeLocation.upsert({
    where: { code: "CDW" },
    update: { taxDistrictId },
    create: {
      name: "Central Distribution Warehouse",
      code: "CDW",
      type: "WAREHOUSE",
      address: "1 Quarry Hill Industrial Park",
      city: "Quarryville",
      state: "CT",
      zip: "06070",
      sortOrder: 0,
      taxDistrictId,
      createdBy: SEED_ACTOR,
    },
  });

  const warehouseStock = await prisma.stockLocation.upsert({
    where: { storeLocationId_code: { storeLocationId: warehouse.id, code: "BULK" } },
    update: {},
    create: {
      storeLocationId: warehouse.id,
      code: "BULK",
      name: "Central Warehouse — Bulk Storage",
      locationType: "STOCK",
      isActive: true,
      sortOrder: 0,
      locationAliases: ["Warehouse", "Central Warehouse"],
      createdBy: SEED_ACTOR,
    },
  });

  // A staging bay for goods that are on hand but already sold. The flag --
  // not the name -- is what keeps this stock out of available-to-sell
  // quantities (lib/inventory/allocation.ts) and puts it in the Buyers
  // Report's Cust Stock column. Named without the word "Customer" on
  // purpose: the shipped seed should demonstrate that holt no longer cares
  // what the location is called (see CLAUDE.md rule 61).
  const warehouseCommitted = await prisma.stockLocation.upsert({
    where: { storeLocationId_code: { storeLocationId: warehouse.id, code: "HOLD" } },
    update: {},
    create: {
      storeLocationId: warehouse.id,
      code: "HOLD",
      name: "Central Warehouse — Sold Goods Staging",
      locationType: "STOCK",
      isActive: true,
      sortOrder: 1,
      holdsCommittedStock: true,
      locationAliases: ["Sold Goods Staging"],
      createdBy: SEED_ACTOR,
    },
  });

  const stores: StoreSetup[] = [];
  for (const [i, def] of STORE_DEFS.entries()) {
    const store = await prisma.storeLocation.upsert({
      where: { code: def.code },
      update: { taxDistrictId },
      create: {
        name: def.name,
        code: def.code,
        type: "STORE",
        address: def.address,
        city: def.city,
        state: def.state,
        zip: def.zip,
        sortOrder: i + 1,
        taxDistrictId,
        createdBy: SEED_ACTOR,
      },
    });

    const floor = await prisma.stockLocation.upsert({
      where: { storeLocationId_code: { storeLocationId: store.id, code: "FLOOR" } },
      update: {},
      create: {
        storeLocationId: store.id,
        code: "FLOOR",
        name: `${def.name} — Sales Floor`,
        locationType: "FLOOR",
        isActive: true,
        sortOrder: 0,
        locationAliases: [`${def.code} Floor`],
        createdBy: SEED_ACTOR,
      },
    });

    const backStock = await prisma.stockLocation.upsert({
      where: { storeLocationId_code: { storeLocationId: store.id, code: "BACK" } },
      update: {},
      create: {
        storeLocationId: store.id,
        code: "BACK",
        name: `${def.name} — Back Stock`,
        locationType: "STOCK",
        isActive: true,
        sortOrder: 1,
        locationAliases: [`${def.code} Back Stock`],
        createdBy: SEED_ACTOR,
      },
    });

    await prisma.storeLocation.update({
      where: { id: store.id },
      data: { defaultReceivingStockLocationId: backStock.id },
    });

    const registerIds: number[] = [];
    for (const registerName of ["Register 1", "Register 2"]) {
      const register = await prisma.register.upsert({
        where: { storeLocationId_name: { storeLocationId: store.id, name: registerName } },
        update: {},
        create: {
          name: registerName,
          storeLocationId: store.id,
          isActive: true,
          createdBy: SEED_ACTOR,
        },
      });
      registerIds.push(register.id);
    }

    stores.push({
      id: store.id,
      name: store.name,
      code: store.code,
      floorStockLocationId: floor.id,
      backStockLocationId: backStock.id,
      registerIds,
    });
  }

  return {
    stores,
    warehouseStockLocationId: warehouseStock.id,
    warehouseCommittedStockLocationId: warehouseCommitted.id,
  };
}
