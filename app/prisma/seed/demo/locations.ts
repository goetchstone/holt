// app/prisma/seed/demo/locations.ts
//
// StoreLocations (two showrooms + one warehouse), their StockLocations, and
// the Registers each showroom runs its POS on.

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

export async function seedLocations(prisma: PrismaClient): Promise<LocationsSetup> {
  const warehouse = await prisma.storeLocation.upsert({
    where: { code: "CDW" },
    update: {},
    create: {
      name: "Central Distribution Warehouse",
      code: "CDW",
      type: "WAREHOUSE",
      address: "1 Quarry Hill Industrial Park",
      city: "Quarryville",
      state: "CT",
      zip: "06070",
      sortOrder: 0,
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

  const stores: StoreSetup[] = [];
  for (const [i, def] of STORE_DEFS.entries()) {
    const store = await prisma.storeLocation.upsert({
      where: { code: def.code },
      update: {},
      create: {
        name: def.name,
        code: def.code,
        type: "STORE",
        address: def.address,
        city: def.city,
        state: def.state,
        zip: def.zip,
        sortOrder: i + 1,
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

  return { stores, warehouseStockLocationId: warehouseStock.id };
}
