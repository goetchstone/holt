// /app/__tests__/integration/allocationScope.integration.test.ts
//
// Ledger plan phase 10: an order draws stock from its own store and the store
// it is fulfilled from (StoreLocation.fulfilmentStoreLocationId), back stock
// before floor models, and a take-with line only at its own store, floor piece
// first. Delivery then takes the units from wherever they were committed.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { allocate, consume } from "@/lib/inventory/allocation";
import { toQty } from "@/lib/inventory/quantity";
import { stockAt } from "../helpers/stock";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Living" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const warehouse = await prisma.storeLocation.create({
    data: { name: "Warehouse", code: "WH", type: "WAREHOUSE" },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Showroom", code: "SR", type: "STORE", fulfilmentStoreLocationId: warehouse.id },
  });
  const place = (storeLocationId: number, code: string, locationType = "STOCK") =>
    prisma.stockLocation.create({ data: { storeLocationId, code, name: code, locationType } });
  const storeFloor = await place(store.id, "FLOOR", "FLOOR");
  const storeBack = await place(store.id, "BACK");
  const whBay = await place(warehouse.id, "BAY");
  const product = await prisma.product.create({
    data: {
      productNumber: "S-1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  const order = await prisma.salesOrder.create({
    data: { orderno: "SO-1", status: "ORDER", orderDate: new Date(), customerId: customer.id },
  });
  const at = (stockLocationId: number, storeLocationId: number, quantity: number) =>
    stockAt({ productId: product.id, storeLocationId, stockLocationId, quantity });
  return { warehouse, store, storeFloor, storeBack, whBay, product, order, at };
}

async function committedAt(orderId: number) {
  const rows = await prisma.inventoryPosition.findMany({
    where: { salesOrderId: orderId },
    include: { stockLocation: { select: { code: true } } },
    orderBy: { stockLocationId: "asc" },
  });
  return Object.fromEntries(rows.map((r) => [r.stockLocation.code, toQty(r.quantity)]));
}

describe("allocation scope (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("takes back stock before the floor model, its own store's first", async () => {
    const w = await world();
    await w.at(w.storeFloor.id, w.store.id, 1);
    await w.at(w.storeBack.id, w.store.id, 1);
    await w.at(w.whBay.id, w.warehouse.id, 5);

    await allocate(
      w.order.id,
      [{ productId: w.product.id, quantity: 3, storeLocationId: w.store.id }],
      prisma,
    );

    // 1 from the showroom's back stock, then 2 from the warehouse; the floor
    // model is not touched while back stock is in reach.
    expect(await committedAt(w.order.id)).toEqual({ BACK: 1, BAY: 2 });
  });

  it("reaches the floor model only when back stock runs out", async () => {
    const w = await world();
    await w.at(w.storeFloor.id, w.store.id, 1);
    await w.at(w.whBay.id, w.warehouse.id, 1);

    const result = await allocate(
      w.order.id,
      [{ productId: w.product.id, quantity: 2, storeLocationId: w.store.id }],
      prisma,
    );

    expect(result.shortfalls).toEqual([]);
    expect(await committedAt(w.order.id)).toEqual({ FLOOR: 1, BAY: 1 });
  });

  it("a take-with line stays at its own store and takes the floor piece first", async () => {
    const w = await world();
    await w.at(w.storeFloor.id, w.store.id, 1);
    await w.at(w.storeBack.id, w.store.id, 1);
    await w.at(w.whBay.id, w.warehouse.id, 5);

    const result = await allocate(
      w.order.id,
      [{ productId: w.product.id, quantity: 3, storeLocationId: w.store.id, takeWith: true }],
      prisma,
    );

    expect(await committedAt(w.order.id)).toEqual({ FLOOR: 1, BACK: 1 });
    expect(result.shortfalls[0]).toMatchObject({ allocated: 2, shortfall: 1 });
  });

  it("a store with no fulfilment store draws only its own stock", async () => {
    const w = await world();
    await prisma.storeLocation.update({
      where: { id: w.store.id },
      data: { fulfilmentStoreLocationId: null },
    });
    await w.at(w.whBay.id, w.warehouse.id, 5);

    const result = await allocate(
      w.order.id,
      [{ productId: w.product.id, quantity: 1, storeLocationId: w.store.id }],
      prisma,
    );

    expect(result.shortfalls[0]).toMatchObject({ allocated: 0, shortfall: 1 });
  });

  it("delivering takes the units from the warehouse they were committed at", async () => {
    const w = await world();
    await w.at(w.whBay.id, w.warehouse.id, 2);
    await allocate(
      w.order.id,
      [{ productId: w.product.id, quantity: 2, storeLocationId: w.store.id }],
      prisma,
    );

    await consume(w.order.id, [{ productId: w.product.id, quantity: 2 }], prisma);

    expect(await prisma.inventoryPosition.count({ where: { productId: w.product.id } })).toBe(0);
  });
});
