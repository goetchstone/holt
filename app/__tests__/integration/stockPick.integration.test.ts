// /app/__tests__/integration/stockPick.integration.test.ts
//
// Pick, stage and load a delivery run against real Postgres
// (lib/fulfilment/pick.ts): a pick moves the order's own unit to the loading
// bay and the pull list shrinks; a multi-box unit is picked only whole; a
// stray box picked with its unit is reunited; the run loads only when nothing
// is left to pull.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { buildPullList } from "@/lib/fulfilment/pullList";
import { loadRun, pickUnits } from "@/lib/fulfilment/pick";
import { stockAt } from "../helpers/stock";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string, boxesPerUnit: number | null = null) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        boxesPerUnit,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const lamp = await product("LAMP");
  const sofa = await product("SOFA", 3);
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const bay = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BAY", name: "Bay" },
  });
  const dock = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "DOCK", name: "Loading Bay", locationType: "STAGING" },
  });
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-1",
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: "Mill",
      storeLocationId: store.id,
      deliveryMethod: "DELIVERY",
      lineItems: {
        create: [
          { lineNumber: 1, productId: lamp.id, orderedQuantity: 2, netPrice: 200, cost: 80 },
          { lineNumber: 2, productId: sofa.id, orderedQuantity: 1, netPrice: 2000, cost: 900 },
        ],
      },
    },
  });
  for (const [p, q] of [
    [lamp.id, 2],
    [sofa.id, 1],
  ] as const) {
    await stockAt({
      productId: p,
      storeLocationId: store.id,
      stockLocationId: bay.id,
      quantity: q,
      salesOrderId: order.id,
    });
  }
  const vehicle = await prisma.vehicle.create({ data: { name: "Truck" } });
  const appointment = await prisma.serviceAppointment.create({
    data: {
      appointmentNumber: "APPT-1",
      type: "DELIVERY",
      status: "SCHEDULED",
      salesOrderId: order.id,
      customerId: customer.id,
      storeLocationId: store.id,
      scheduledDate: new Date(),
    },
  });
  const run = await prisma.deliveryRun.create({
    data: { runNumber: "RUN-1", runDate: new Date(), vehicleId: vehicle.id, status: "PLANNING" },
  });
  await prisma.deliveryStop.create({
    data: {
      deliveryRunId: run.id,
      serviceAppointmentId: appointment.id,
      stopOrder: 1,
      status: "PENDING",
    },
  });
  return { lamp, sofa, store, bay, dock, order, run };
}

describe("pick, stage and load (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a pick moves the order's own unit to the bay, and the pull list shrinks", async () => {
    const w = await world();
    expect((await buildPullList(prisma, { deliveryRunId: w.run.id })).rows).toHaveLength(2);
    await prisma.$transaction((tx) =>
      pickUnits(tx, {
        deliveryRunId: w.run.id,
        salesOrderId: w.order.id,
        productId: w.lamp.id,
        units: 2,
        fromStockLocationId: w.bay.id,
        toStockLocationId: w.dock.id,
        actor: null,
      }),
    );
    const atDock = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: w.lamp.id, stockLocationId: w.dock.id },
    });
    expect(atDock).toMatchObject({ salesOrderId: w.order.id });
    expect(Number(atDock.quantity)).toBe(2);
    const { rows } = await buildPullList(prisma, { deliveryRunId: w.run.id });
    expect(rows.map((r) => r.productId)).toEqual([w.sofa.id]);
  });

  it("a multi-box unit is picked only whole, and a stray box picked with it is reunited", async () => {
    const w = await world();
    const pick = (boxes: number[]) =>
      prisma.$transaction((tx) =>
        pickUnits(tx, {
          deliveryRunId: w.run.id,
          salesOrderId: w.order.id,
          productId: w.sofa.id,
          units: 1,
          fromStockLocationId: w.bay.id,
          toStockLocationId: w.dock.id,
          boxes,
          actor: null,
        }),
      );
    await expect(pick([1, 2])).rejects.toThrow("box 3 is missing");
    const stray = await prisma.boxNote.create({
      data: {
        kind: "STRAY",
        productId: w.sofa.id,
        storeLocationId: w.store.id,
        stockLocationId: w.bay.id,
        boxes: [3],
        boxesPerUnit: 3,
      },
    });
    expect(await pick([1, 2, 3])).toEqual({ picked: 1, reunitedBoxes: 1 });
    expect((await prisma.boxNote.findUniqueOrThrow({ where: { id: stray.id } })).clearReason).toBe(
      "Picked with its unit",
    );
  });

  it("refuses a pick to a place that is not a loading bay, and an order not on the run", async () => {
    const w = await world();
    await expect(
      prisma.$transaction((tx) =>
        pickUnits(tx, {
          deliveryRunId: w.run.id,
          salesOrderId: w.order.id,
          productId: w.lamp.id,
          units: 1,
          fromStockLocationId: w.bay.id,
          toStockLocationId: w.bay.id,
          actor: null,
        }),
      ),
    ).rejects.toThrow("staging place");
    await expect(
      prisma.$transaction((tx) =>
        pickUnits(tx, {
          deliveryRunId: w.run.id,
          salesOrderId: 999999,
          productId: w.lamp.id,
          units: 1,
          fromStockLocationId: w.bay.id,
          toStockLocationId: w.dock.id,
          actor: null,
        }),
      ),
    ).rejects.toThrow("not on this run");
  });

  it("loads the run only when nothing is left to pull", async () => {
    const w = await world();
    await expect(prisma.$transaction((tx) => loadRun(tx, w.run.id, null))).rejects.toThrow(
      "not at the loading bay",
    );
    await prisma.$transaction(async (tx) => {
      await pickUnits(tx, {
        deliveryRunId: w.run.id,
        salesOrderId: w.order.id,
        productId: w.lamp.id,
        units: 2,
        fromStockLocationId: w.bay.id,
        toStockLocationId: w.dock.id,
        actor: null,
      });
      await pickUnits(tx, {
        deliveryRunId: w.run.id,
        salesOrderId: w.order.id,
        productId: w.sofa.id,
        units: 1,
        fromStockLocationId: w.bay.id,
        toStockLocationId: w.dock.id,
        boxes: [3, 1, 2],
        actor: null,
      });
    });
    await prisma.$transaction((tx) => loadRun(tx, w.run.id, "loader"));
    expect((await prisma.deliveryRun.findUniqueOrThrow({ where: { id: w.run.id } })).status).toBe(
      "LOADED",
    );
  });
});
