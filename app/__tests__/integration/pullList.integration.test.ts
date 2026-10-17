// /app/__tests__/integration/pullList.integration.test.ts
//
// Ledger plan phase 9: one pull-list builder for delivery runs and orders.
//
// The two builders it replaces listed cancelled and replaced lines (rule 33),
// sent a picker to whichever row of the product had the most units -- another
// customer's committed sofa included -- and disagreed with each other. The pull
// list lists only an order's active lines, from the order's own committed
// stock, and drops what is already where the order leaves from.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { allocate } from "@/lib/inventory/allocation";
import { postMovement } from "@/lib/inventory/ledger";
import { buildPullList } from "@/lib/fulfilment/pullList";
import { stockAt } from "../helpers/stock";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Living" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Showroom", code: "SR", type: "STORE" },
  });
  const warehouse = await prisma.storeLocation.create({
    data: { name: "Warehouse", code: "WH", type: "WAREHOUSE" },
  });
  const back = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BACK", name: "Back" },
  });
  const dock = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "DOCK", name: "Loading bay", locationType: "STAGING" },
  });
  const bay = await prisma.stockLocation.create({
    data: { storeLocationId: warehouse.id, code: "BAY", name: "Bay" },
  });
  const mk = (n: string) =>
    prisma.product.create({
      data: {
        productNumber: n,
        name: n,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const sofa = await mk("SOFA");
  const chair = await mk("CHAIR");
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  return { store, warehouse, back, dock, bay, sofa, chair, customer };
}

type World = Awaited<ReturnType<typeof world>>;

async function orderWith(
  w: World,
  lines: { productId: number; quantity: number; status?: "ACTIVE" | "CANCELLED" | "REPLACED" }[],
  deliveryMethod: "DELIVERY" | "PICKUP" = "DELIVERY",
) {
  return prisma.salesOrder.create({
    data: {
      orderno: `SO-${Math.random().toString(36).slice(2, 7)}`,
      status: "ORDER",
      orderDate: new Date(),
      customerId: w.customer.id,
      storeLocation: w.store.name,
      storeLocationId: w.store.id,
      deliveryMethod,
      lineItems: {
        create: lines.map((l, i) => ({
          lineNumber: i + 1,
          productId: l.productId,
          productName: "x",
          orderedQuantity: l.quantity,
          netPrice: 100,
          cost: 40,
          vatRate: 0,
          vatAmount: 0,
          lineItemStatus: l.status ?? "ACTIVE",
        })),
      },
    },
  });
}

const commit = (orderId: number, productId: number, storeLocationId: number, quantity: number) =>
  allocate(orderId, [{ productId, quantity, storeLocationId }], prisma);

describe("the pull list (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lists active lines only, from the order's own committed stock", async () => {
    const w = await world();
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.back.id,
      quantity: 5,
    });
    const order = await orderWith(w, [
      { productId: w.sofa.id, quantity: 2 },
      { productId: w.chair.id, quantity: 4, status: "CANCELLED" },
      { productId: w.chair.id, quantity: 1, status: "REPLACED" },
    ]);
    await commit(order.id, w.sofa.id, w.store.id, 2);
    // Another order holds the rest; it must never be listed for this one.
    const other = await orderWith(w, [{ productId: w.sofa.id, quantity: 3 }]);
    await commit(other.id, w.sofa.id, w.store.id, 3);

    const { rows } = await buildPullList(prisma, { salesOrderId: order.id });

    expect(rows).toEqual([
      expect.objectContaining({
        productId: w.sofa.id,
        quantity: 2,
        fromStockLocationId: w.back.id,
        crossSite: false,
      }),
    ]);
  });

  it("shows what the order holds none of as a row with no place", async () => {
    const w = await world();
    const order = await orderWith(w, [{ productId: w.sofa.id, quantity: 2 }]);

    const { rows } = await buildPullList(prisma, { salesOrderId: order.id });

    expect(rows).toEqual([
      expect.objectContaining({
        quantity: 2,
        fromStockLocationId: null,
        fromStoreLocationId: null,
      }),
    ]);
  });

  it("drops what is already staged, so doing a pull shrinks the list", async () => {
    const w = await world();
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.back.id,
      quantity: 3,
    });
    const order = await orderWith(w, [{ productId: w.sofa.id, quantity: 3 }]);
    await commit(order.id, w.sofa.id, w.store.id, 3);

    await postMovement(prisma, {
      productId: w.sofa.id,
      quantity: 2,
      from: { storeLocationId: w.store.id, stockLocationId: w.back.id, salesOrderId: order.id },
      to: { storeLocationId: w.store.id, stockLocationId: w.dock.id, salesOrderId: order.id },
      reason: "TRANSFER",
    });

    const { rows } = await buildPullList(prisma, { salesOrderId: order.id });
    expect(rows.map((r) => r.quantity)).toEqual([1]);
  });

  // The store fulfils from the warehouse, and the unit is committed there.
  async function atTheWarehouse(deliveryMethod: "DELIVERY" | "PICKUP") {
    const w = await world();
    await prisma.storeLocation.update({
      where: { id: w.store.id },
      data: { fulfilmentStoreLocationId: w.warehouse.id },
    });
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.warehouse.id,
      stockLocationId: w.bay.id,
      quantity: 1,
    });
    const order = await orderWith(w, [{ productId: w.sofa.id, quantity: 1 }], deliveryMethod);
    await commit(order.id, w.sofa.id, w.store.id, 1);
    return { w, rows: (await buildPullList(prisma, { salesOrderId: order.id })).rows };
  }

  it("flags a pickup's units at another store: they need a transfer first", async () => {
    const { w, rows } = await atTheWarehouse("PICKUP");
    expect(rows).toEqual([
      expect.objectContaining({ fromStoreLocationId: w.warehouse.id, crossSite: true }),
    ]);
  });

  it("does not flag a delivery's units at the store that fulfils for it", async () => {
    const { w, rows } = await atTheWarehouse("DELIVERY");
    expect(rows).toEqual([
      expect.objectContaining({ fromStoreLocationId: w.warehouse.id, crossSite: false }),
    ]);
  });

  it("a pickup at a store with no pickup place says so", async () => {
    const w = await world();
    const order = await orderWith(w, [{ productId: w.sofa.id, quantity: 1 }], "PICKUP");

    const { notes } = await buildPullList(prisma, { salesOrderId: order.id });
    expect(notes).toEqual([expect.stringContaining("set a pickup place")]);
  });

  it("units already at the pickup place count as pulled", async () => {
    const w = await world();
    const pickup = await prisma.stockLocation.create({
      data: {
        storeLocationId: w.store.id,
        code: "PICKUP",
        name: "Pickup",
        locationType: "STAGING",
      },
    });
    await prisma.storeLocation.update({
      where: { id: w.store.id },
      data: { pickupStockLocationId: pickup.id },
    });
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.back.id,
      quantity: 2,
    });
    const order = await orderWith(w, [{ productId: w.sofa.id, quantity: 2 }], "PICKUP");
    await commit(order.id, w.sofa.id, w.store.id, 2);
    await postMovement(prisma, {
      productId: w.sofa.id,
      quantity: 2,
      from: { storeLocationId: w.store.id, stockLocationId: w.back.id, salesOrderId: order.id },
      to: { storeLocationId: w.store.id, stockLocationId: pickup.id, salesOrderId: order.id },
      reason: "TRANSFER",
    });

    const { rows, notes } = await buildPullList(prisma, { salesOrderId: order.id });
    expect(rows).toEqual([]);
    expect(notes).toEqual([]);
  });
});
