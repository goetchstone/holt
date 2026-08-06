// /app/__tests__/integration/inventoryAllocation.integration.test.ts
//
// The allocation lifecycle against real Postgres, because the bug this module
// was drafted with only exists against real Postgres.
//
// InventoryPosition's unique key is
// [productId, storeLocationId, stockLocationId, salesOrderId] and BOTH
// stockLocationId and salesOrderId are nullable. Postgres treats NULLs as
// DISTINCT in a unique index unless it is declared NULLS NOT DISTINCT, and
// this one is not. So the constraint does not prevent duplicate free rows, and
// an upsert keyed through those columns never matches -- it creates another
// row every time. Free stock multiplies instead of merging, and no mocked test
// would notice, because the mock has no index semantics to get wrong.
//
// The merge cases below are therefore the point of this file, not decoration.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { allocate, availableQuantity, consume, release } from "@/lib/inventory/allocation";

async function seed() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const floor = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "FLOOR", name: "Floor" },
  });
  // The Ordorite convention for "already spoken for": a stock location whose
  // name starts with Customer. Native allocation must never draw from it.
  const held = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "CUST", name: "Customer Holds" },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "P1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
    },
  });
  const order = await prisma.salesOrder.create({
    data: { orderno: "SO-1", status: "ORDER", storeLocation: store.name },
  });
  const other = await prisma.salesOrder.create({
    data: { orderno: "SO-2", status: "ORDER", storeLocation: store.name },
  });
  return { store, floor, held, product, order, other };
}

const freeRows = (productId: number) =>
  prisma.inventoryPosition.findMany({
    where: { productId, salesOrderId: null },
    orderBy: { id: "asc" },
  });

describe("inventory allocation (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("selling reduces available stock", async () => {
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);

    const result = await allocate(
      order.id,
      [{ productId: product.id, quantity: 2, storeLocationId: store.id }],
      prisma,
    );

    expect(result.shortfalls).toEqual([]);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);
  });

  it("splits a position rather than moving all of it", async () => {
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    await allocate(order.id, [{ productId: product.id, quantity: 2, storeLocationId: store.id }], prisma);

    const free = await freeRows(product.id);
    const committed = await prisma.inventoryPosition.findMany({ where: { salesOrderId: order.id } });
    expect(free.map((r) => r.quantity)).toEqual([3]);
    expect(committed.map((r) => r.quantity)).toEqual([2]);
  });

  it("cancelling MERGES stock back instead of fragmenting it", async () => {
    // The bug. With an upsert keyed on the compound unique index, the
    // salesOrderId: null side never matches and this leaves TWO free rows.
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    await allocate(order.id, [{ productId: product.id, quantity: 2, storeLocationId: store.id }], prisma);
    await release(order.id, prisma);

    const free = await freeRows(product.id);
    expect(free).toHaveLength(1);
    expect(free[0].quantity).toBe(5);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);
  });

  it("merges correctly when the position has NO stock location", async () => {
    // stockLocationId is nullable too, and it is the other half of the same
    // NULL-distinct problem -- a null there breaks the key match just as a
    // null salesOrderId does.
    const { store, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, quantity: 4 },
    });

    await allocate(order.id, [{ productId: product.id, quantity: 1, storeLocationId: store.id }], prisma);
    await release(order.id, prisma);

    const free = await freeRows(product.id);
    expect(free).toHaveLength(1);
    expect(free[0].quantity).toBe(4);
  });

  it("allocating twice for one order merges into a single committed row", async () => {
    // Two cart lines for the same product is ordinary, not an edge case.
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 9 },
    });

    await allocate(order.id, [{ productId: product.id, quantity: 2, storeLocationId: store.id }], prisma);
    await allocate(order.id, [{ productId: product.id, quantity: 3, storeLocationId: store.id }], prisma);

    const committed = await prisma.inventoryPosition.findMany({ where: { salesOrderId: order.id } });
    expect(committed).toHaveLength(1);
    expect(committed[0].quantity).toBe(5);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(4);
  });

  it("fulfilment removes the stock outright", async () => {
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    await allocate(order.id, [{ productId: product.id, quantity: 2, storeLocationId: store.id }], prisma);
    await consume(order.id, [{ productId: product.id, quantity: 2 }], prisma);

    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: order.id } })).toBe(0);
    // The goods left the building: 3 remain, not 5.
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);
  });

  it("never draws from another order's committed stock", async () => {
    const { store, floor, product, order, other } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 3 },
    });
    await allocate(other.id, [{ productId: product.id, quantity: 3, storeLocationId: store.id }], prisma);

    const result = await allocate(
      order.id,
      [{ productId: product.id, quantity: 1, storeLocationId: store.id }],
      prisma,
    );

    expect(result.shortfalls[0].shortfall).toBe(1);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: order.id } })).toBe(0);
  });

  it("never draws from a Customer-hold location", async () => {
    // The imported-data convention. Treating it as free stock would sell
    // something already promised to someone.
    const { store, held, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: held.id, quantity: 7 },
    });

    expect(await availableQuantity(product.id, store.id, prisma)).toBe(0);

    const result = await allocate(
      order.id,
      [{ productId: product.id, quantity: 1, storeLocationId: store.id }],
      prisma,
    );
    expect(result.shortfalls[0].shortfall).toBe(1);
  });

  it("lets the sale through when stock is short, and reports it", async () => {
    // The owner's rule: if a cashier scans it, it sells. The discrepancy is
    // back-office work, never a checkout interruption.
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 1 },
    });

    const result = await allocate(
      order.id,
      [{ productId: product.id, quantity: 3, storeLocationId: store.id }],
      prisma,
    );

    expect(result.shortfalls).toEqual([
      { productId: product.id, storeLocationId: store.id, requested: 3, allocated: 1, shortfall: 2 },
    ]);
    // It took what existed rather than refusing or taking nothing.
    const committed = await prisma.inventoryPosition.findMany({ where: { salesOrderId: order.id } });
    expect(committed[0].quantity).toBe(1);
  });

  it("a return line allocates nothing", async () => {
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    await allocate(order.id, [{ productId: product.id, quantity: -1, storeLocationId: store.id }], prisma);

    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: order.id } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);
  });

  it("draws across several free positions when one is not enough", async () => {
    const { store, floor, product, order } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 2 },
    });
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, quantity: 3 },
    });

    const result = await allocate(
      order.id,
      [{ productId: product.id, quantity: 4, storeLocationId: store.id }],
      prisma,
    );

    expect(result.shortfalls).toEqual([]);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(1);
  });
});
