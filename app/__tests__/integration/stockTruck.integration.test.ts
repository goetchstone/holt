// /app/__tests__/integration/stockTruck.integration.test.ts
//
// A delivery run's truck is a place (lib/fulfilment/truck.ts, DECISIONS #25),
// against real Postgres: loading moves the loading bay's units onto it, a
// delivery draws from it first, a stop that could not be done leaves its units
// aboard, the run is completed only once they are unloaded to a bay, and a
// unit on another run's truck is still to pull. The drift check after every
// test (jest.integration.afterEach.ts) holds the journal to the balance.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { buildPullList } from "@/lib/fulfilment/pullList";
import { loadRun, pickUnits } from "@/lib/fulfilment/pick";
import { setRunStatus } from "@/lib/fulfilment/runs";
import { completeStop, failStop } from "@/lib/fulfilment/stops";
import { aboard, unloadRun } from "@/lib/fulfilment/truck";
import { stockAt } from "../helpers/stock";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const lamp = await product("LAMP");
  const sofa = await product("SOFA");
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const shelf = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "SHELF", name: "Shelf" },
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
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
  for (const [p, q] of [
    [lamp.id, 2],
    [sofa.id, 1],
  ] as const) {
    await stockAt({
      productId: p,
      storeLocationId: store.id,
      stockLocationId: shelf.id,
      quantity: q,
      salesOrderId: order.id,
    });
  }
  const vehicle = await prisma.vehicle.create({ data: { name: "Truck 1" } });
  const run = await newRun("DR-1", vehicle.id);
  const stop = await addStop(run.id, order.id, customer.id, store.id, "APPT-1");
  return { lamp, sofa, store, shelf, dock, order, customer, vehicle, run, stop };
}

function newRun(runNumber: string, vehicleId: number) {
  return prisma.deliveryRun.create({
    data: { runNumber, runDate: new Date(), vehicleId, status: "PLANNING" },
  });
}

async function addStop(
  deliveryRunId: number,
  salesOrderId: number,
  customerId: number,
  storeLocationId: number,
  appointmentNumber: string,
) {
  const appointment = await prisma.serviceAppointment.create({
    data: {
      appointmentNumber,
      type: "DELIVERY",
      status: "SCHEDULED",
      salesOrderId,
      customerId,
      storeLocationId,
      scheduledDate: new Date(),
    },
  });
  return prisma.deliveryStop.create({
    data: { deliveryRunId, serviceAppointmentId: appointment.id, stopOrder: 1, status: "PENDING" },
  });
}

type World = Awaited<ReturnType<typeof world>>;

/** Pick `units` of a product from the shelf to the dock for the run. */
function pick(w: World, productId: number, units: number) {
  return prisma.$transaction((tx) =>
    pickUnits(tx, {
      deliveryRunId: w.run.id,
      salesOrderId: w.order.id,
      productId,
      units,
      fromStockLocationId: w.shelf.id,
      toStockLocationId: w.dock.id,
      actor: null,
    }),
  );
}

const status = (w: World, s: "LOADED" | "IN_PROGRESS" | "COMPLETED") =>
  prisma.$transaction((tx) => setRunStatus(tx, w.run.id, s, "desk"));

async function held(w: World, stockLocationId: number) {
  const rows = await prisma.inventoryPosition.findMany({
    where: { stockLocationId },
    orderBy: { productId: "asc" },
  });
  return rows.map((r) => ({
    productId: r.productId,
    salesOrderId: r.salesOrderId,
    quantity: Number(r.quantity),
  }));
}

const truckOf = (runId: number) =>
  prisma.stockLocation.findMany({ where: { deliveryRunId: runId } });

describe("a delivery run's truck is a place (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("loading moves what is at the loading bay onto the run's truck, still the order's", async () => {
    const w = await world();
    await pick(w, w.lamp.id, 2);
    await pick(w, w.sofa.id, 1);

    expect(await prisma.$transaction((tx) => loadRun(tx, w.run.id, "loader"))).toEqual({
      loaded: true,
      boarded: 3,
    });

    const [truck] = await truckOf(w.run.id);
    expect(truck).toMatchObject({
      storeLocationId: w.store.id,
      locationType: "TRANSIT",
      isActive: true,
      code: "TRUCK-DR-1",
      name: "Truck 1 (DR-1)",
    });
    expect(await held(w, truck.id)).toEqual([
      { productId: w.lamp.id, salesOrderId: w.order.id, quantity: 2 },
      { productId: w.sofa.id, salesOrderId: w.order.id, quantity: 1 },
    ]);
    expect(await held(w, w.dock.id)).toEqual([]);
    // Units on the run's own truck are pulled: nothing left on the list.
    expect((await buildPullList(prisma, { deliveryRunId: w.run.id })).rows).toEqual([]);
    expect(
      await prisma.stockMovement.count({
        where: { sourceType: "DeliveryRun", sourceId: w.run.id, toStockLocationId: truck.id },
      }),
    ).toBe(2);

    // Loading again moves nothing more and makes no second truck.
    expect(await prisma.$transaction((tx) => loadRun(tx, w.run.id, "loader"))).toEqual({
      loaded: true,
      boarded: 0,
    });
    expect(await truckOf(w.run.id)).toHaveLength(1);
  });

  it("the desk's LOADED boards the bay too, and a part delivery draws from the truck first", async () => {
    const w = await world();
    await pick(w, w.lamp.id, 1); // the other lamp and the sofa stay on the shelf
    await status(w, "LOADED");
    const [truck] = await truckOf(w.run.id);
    expect(await held(w, truck.id)).toEqual([
      { productId: w.lamp.id, salesOrderId: w.order.id, quantity: 1 },
    ]);
    await status(w, "IN_PROGRESS");

    const lampLine = w.order.lineItems[0];
    const outcome = await prisma.$transaction((tx) =>
      completeStop(tx, w.stop.id, {
        at: new Date(),
        delivered: [{ orderLineItemId: lampLine.id, quantity: 1 }],
        actor: "driver",
      }),
    );
    expect(outcome.delivery).toMatchObject({ changed: true, complete: false });

    // The lamp that went is the one on the truck; the shelf's are untouched.
    expect(await held(w, truck.id)).toEqual([]);
    expect(await held(w, w.shelf.id)).toEqual([
      { productId: w.lamp.id, salesOrderId: w.order.id, quantity: 1 },
      { productId: w.sofa.id, salesOrderId: w.order.id, quantity: 1 },
    ]);

    await status(w, "COMPLETED");
    expect((await prisma.stockLocation.findUniqueOrThrow({ where: { id: truck.id } })).isActive).toBe(
      false,
    );
  });

  it("a full delivery takes everything off the truck, and the run completes", async () => {
    const w = await world();
    await pick(w, w.lamp.id, 2);
    await pick(w, w.sofa.id, 1);
    await prisma.$transaction((tx) => loadRun(tx, w.run.id, null));
    await status(w, "IN_PROGRESS");
    await prisma.$transaction((tx) => completeStop(tx, w.stop.id, { at: new Date(), actor: null }));

    expect(await aboard(prisma, w.run.id)).toEqual([]);
    expect(
      await prisma.inventoryPosition.count({ where: { salesOrderId: w.order.id } }),
    ).toBe(0);
    await status(w, "COMPLETED");
  });

  it("a failed stop leaves its units aboard; the run completes only once they are unloaded", async () => {
    const w = await world();
    await pick(w, w.lamp.id, 2);
    await pick(w, w.sofa.id, 1);
    await prisma.$transaction((tx) => loadRun(tx, w.run.id, null));
    await status(w, "IN_PROGRESS");
    await prisma.$transaction((tx) =>
      failStop(tx, w.stop.id, { reason: "Nobody home", actor: "driver" }),
    );

    const [truck] = await truckOf(w.run.id);
    expect(await held(w, truck.id)).toEqual([
      { productId: w.lamp.id, salesOrderId: w.order.id, quantity: 2 },
      { productId: w.sofa.id, salesOrderId: w.order.id, quantity: 1 },
    ]);
    // The stop is off the run, so nothing is open -- but the truck is not empty.
    await expect(status(w, "COMPLETED")).rejects.toThrow(
      "still has 2 × LAMP for SO-1, 1 × SOFA for SO-1 on the truck",
    );

    await expect(
      prisma.$transaction((tx) =>
        unloadRun(tx, { deliveryRunId: w.run.id, toStockLocationId: w.shelf.id, actor: null }),
      ),
    ).rejects.toThrow("staging place");

    expect(
      await prisma.$transaction((tx) =>
        unloadRun(tx, { deliveryRunId: w.run.id, toStockLocationId: w.dock.id, actor: "loader" }),
      ),
    ).toEqual({ units: 3 });
    expect(await held(w, truck.id)).toEqual([]);
    expect(await held(w, w.dock.id)).toEqual([
      { productId: w.lamp.id, salesOrderId: w.order.id, quantity: 2 },
      { productId: w.sofa.id, salesOrderId: w.order.id, quantity: 1 },
    ]);
    // Back at the bay, still the order's and already pulled for its next run.
    expect((await buildPullList(prisma, { salesOrderId: w.order.id })).rows).toEqual([]);

    await status(w, "COMPLETED");
    expect((await prisma.stockLocation.findUniqueOrThrow({ where: { id: truck.id } })).isActive).toBe(
      false,
    );
    await expect(
      prisma.$transaction((tx) =>
        unloadRun(tx, { deliveryRunId: w.run.id, toStockLocationId: w.dock.id, actor: null }),
      ),
    ).rejects.toThrow("Nothing is on this run's truck");
  });

  it("a unit still on another run's truck is still to pull for this run", async () => {
    const w = await world();
    await pick(w, w.lamp.id, 2);
    await pick(w, w.sofa.id, 1);
    await prisma.$transaction((tx) => loadRun(tx, w.run.id, null));
    await status(w, "IN_PROGRESS");
    await prisma.$transaction((tx) => failStop(tx, w.stop.id, { reason: "Gate locked", actor: null }));
    const [truck] = await truckOf(w.run.id);

    const next = await newRun("DR-2", w.vehicle.id);
    await addStop(next.id, w.order.id, w.customer.id, w.store.id, "APPT-2");
    const { rows } = await buildPullList(prisma, { deliveryRunId: next.id });
    expect(rows.map((r) => [r.productId, r.quantity, r.fromStockLocationId])).toEqual([
      [w.lamp.id, 2, truck.id],
      [w.sofa.id, 1, truck.id],
    ]);
    // On the order's own list, any truck counts as on its way.
    expect((await buildPullList(prisma, { salesOrderId: w.order.id })).rows).toEqual([]);
    await expect(prisma.$transaction((tx) => loadRun(tx, next.id, null))).rejects.toThrow(
      "not at the loading bay",
    );
  });
});
