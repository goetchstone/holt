// /app/__tests__/integration/stockDelivery.integration.test.ts
//
// What a delivery stop's outcome does, against real Postgres
// (lib/fulfilment/stops.ts, handover.ts recordDelivery):
//
//   - a part delivery hands over what went (from the loading bay first),
//     keeps the rest committed to the order, and puts a DELIVERY appointment
//     for the rest in the dispatch pool -- and a resync does not commit stock
//     again for what went;
//   - delivering the rest is the handover, and consumes only the rest;
//   - a completed stop is handed over once however often it is sent;
//   - more than is still to go is refused, and nothing changes;
//   - a stop that could not be done comes off the run, back to the pool, with
//     the reason on the order and the stock still the order's.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { completeStop, failStop, StopError } from "@/lib/fulfilment/stops";
import { DeliveryError } from "@/lib/fulfilment/handover";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { buildPullList } from "@/lib/fulfilment/pullList";
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
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
  const [lampLine, sofaLine] = order.lineItems;
  const at = (productId: number, stockLocationId: number, quantity: number, owned = true) =>
    stockAt({
      productId,
      storeLocationId: store.id,
      stockLocationId,
      quantity,
      salesOrderId: owned ? order.id : null,
    });
  // One lamp loaded, one still in its bay; the sofa loaded. Free lamps beside.
  await at(lamp.id, dock.id, 1);
  await at(lamp.id, bay.id, 1);
  await at(sofa.id, dock.id, 1);
  await at(lamp.id, bay.id, 5, false);

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
    data: { runNumber: "RUN-1", runDate: new Date(), vehicleId: vehicle.id, status: "IN_PROGRESS" },
  });
  const stop = await prisma.deliveryStop.create({
    data: {
      deliveryRunId: run.id,
      serviceAppointmentId: appointment.id,
      stopOrder: 1,
      status: "ARRIVED",
    },
  });
  return { lamp, sofa, store, bay, dock, order, lampLine, sofaLine, run, stop, appointment };
}

async function held(salesOrderId: number, productId: number, stockLocationId?: number) {
  const rows = await prisma.inventoryPosition.findMany({
    where: { salesOrderId, productId, ...(stockLocationId ? { stockLocationId } : {}) },
  });
  return rows.reduce((s, r) => s + Number(r.quantity), 0);
}

async function delivered(productId: number) {
  const rows = await prisma.stockMovement.findMany({ where: { productId, reason: "DELIVER" } });
  return rows.reduce((s, r) => s + Number(r.quantity), 0);
}

describe("delivery stop outcomes (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a part delivery hands over what went and puts the rest back with dispatch", async () => {
    const w = await world();
    const done = await prisma.$transaction((tx) =>
      completeStop(tx, w.stop.id, {
        at: new Date(),
        delivered: [
          { orderLineItemId: w.lampLine.id, quantity: 1 },
          { orderLineItemId: w.sofaLine.id, quantity: 0 },
        ],
        actor: "driver@x",
      }),
    );
    expect(done.claimed).toBe(true);
    expect(done.delivery).toMatchObject({ changed: true, complete: false });

    // The lamp that went came off the loading bay; the one in its bay stays.
    expect(await held(w.order.id, w.lamp.id, w.dock.id)).toBe(0);
    expect(await held(w.order.id, w.lamp.id, w.bay.id)).toBe(1);
    expect(await held(w.order.id, w.sofa.id, w.dock.id)).toBe(1);
    expect(await delivered(w.lamp.id)).toBe(1);

    const order = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: w.order.id },
      include: { lineItems: { orderBy: { lineNumber: "asc" } } },
    });
    expect(order.deliveredAt).toBeNull();
    expect(order.status).toBe("ORDER");
    expect(order.lineItems.map((l) => Number(l.fulfilledQty))).toEqual([1, 0]);

    const rest = await prisma.serviceAppointment.findUniqueOrThrow({
      where: { id: done.delivery!.restAppointmentId! },
      include: { deliveryStop: true },
    });
    expect(rest).toMatchObject({
      type: "DELIVERY",
      status: "PENDING",
      salesOrderId: w.order.id,
      customerId: w.appointment.customerId,
      deliveryStop: null,
    });
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: w.order.id, changeType: "PARTLY_DELIVERED" },
    });
    expect(log.newValue).toContain("LAMP x1");

    // A resync must not commit a free lamp for the one that already went.
    await prisma.$transaction((tx) => resyncOrderAllocation(w.order.id, "Mill", tx));
    expect(await held(w.order.id, w.lamp.id)).toBe(1);

    // The next run's pull list: the lamp from its bay; the sofa is already loaded.
    const { rows } = await buildPullList(prisma, { salesOrderId: w.order.id });
    expect(rows.map((r) => [r.productId, r.quantity, r.fromStockLocationId])).toEqual([
      [w.lamp.id, 1, w.bay.id],
    ]);
  });

  it("delivering the rest is the handover, and consumes only the rest", async () => {
    const w = await world();
    const first = await prisma.$transaction((tx) =>
      completeStop(tx, w.stop.id, {
        at: new Date(),
        delivered: [{ orderLineItemId: w.lampLine.id, quantity: 1 }],
        actor: null,
      }),
    );
    const run2 = await prisma.deliveryRun.create({
      data: {
        runNumber: "RUN-2",
        runDate: new Date(),
        vehicleId: w.run.vehicleId,
        status: "IN_PROGRESS",
      },
    });
    const stop2 = await prisma.deliveryStop.create({
      data: {
        deliveryRunId: run2.id,
        serviceAppointmentId: first.delivery!.restAppointmentId!,
        stopOrder: 1,
        status: "ARRIVED",
      },
    });
    const second = await prisma.$transaction((tx) =>
      completeStop(tx, stop2.id, {
        at: new Date(),
        delivered: [
          { orderLineItemId: w.lampLine.id, quantity: 1 },
          { orderLineItemId: w.sofaLine.id, quantity: 1 },
        ],
        actor: null,
      }),
    );
    expect(second.delivery).toMatchObject({ complete: true, restAppointmentId: null });
    const order = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: w.order.id },
      include: { lineItems: { orderBy: { lineNumber: "asc" } } },
    });
    expect(order.deliveredAt).not.toBeNull();
    expect(order.status).toBe("FULFILLED");
    expect(order.lineItems.map((l) => Number(l.fulfilledQty))).toEqual([2, 1]);
    expect(await held(w.order.id, w.lamp.id)).toBe(0);
    expect(await held(w.order.id, w.sofa.id)).toBe(0);
    expect(await delivered(w.lamp.id)).toBe(2);
    expect(await delivered(w.sofa.id)).toBe(1);
    // The free lamps were never touched.
    const free = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: w.lamp.id, salesOrderId: null },
    });
    expect(Number(free.quantity)).toBe(5);
  });

  it("a completed stop is handed over once, however often it is sent", async () => {
    const w = await world();
    const send = () =>
      prisma.$transaction((tx) => completeStop(tx, w.stop.id, { at: new Date(), actor: null }));
    expect((await send()).claimed).toBe(true);
    expect((await send()).claimed).toBe(false);
    expect(await delivered(w.lamp.id)).toBe(2);
    expect(await delivered(w.sofa.id)).toBe(1);
  });

  it("refuses more than is still to go, and nothing changes", async () => {
    const w = await world();
    await expect(
      prisma.$transaction((tx) =>
        completeStop(tx, w.stop.id, {
          at: new Date(),
          delivered: [{ orderLineItemId: w.lampLine.id, quantity: 3 }],
          actor: null,
        }),
      ),
    ).rejects.toThrow(DeliveryError);
    const stop = await prisma.deliveryStop.findUniqueOrThrow({ where: { id: w.stop.id } });
    expect(stop.status).toBe("ARRIVED");
    expect(await delivered(w.lamp.id)).toBe(0);
  });

  it("a stop that could not be done comes off the run, back to the pool", async () => {
    const w = await world();
    await expect(
      prisma.$transaction((tx) => failStop(tx, w.stop.id, { reason: "  ", actor: null })),
    ).rejects.toThrow(StopError);

    await prisma.$transaction((tx) =>
      failStop(tx, w.stop.id, { reason: "Nobody home", actor: "driver@x" }),
    );
    expect(await prisma.deliveryStop.findUnique({ where: { id: w.stop.id } })).toBeNull();
    const appt = await prisma.serviceAppointment.findUniqueOrThrow({
      where: { id: w.appointment.id },
      include: { deliveryStop: true },
    });
    expect(appt.deliveryStop).toBeNull();
    expect(appt.notes).toBe("Could not deliver on run RUN-1: Nobody home");
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: w.order.id, changeType: "DELIVERY_FAILED" },
    });
    expect(log.newValue).toContain("Nobody home");
    // Nothing happened, so nothing was reversed: the order still holds it all.
    expect(await held(w.order.id, w.lamp.id)).toBe(2);
    expect(await held(w.order.id, w.sofa.id)).toBe(1);
    expect(await delivered(w.lamp.id)).toBe(0);
  });

  it("a completed stop cannot be failed", async () => {
    const w = await world();
    await prisma.$transaction((tx) => completeStop(tx, w.stop.id, { at: new Date(), actor: null }));
    await expect(
      prisma.$transaction((tx) => failStop(tx, w.stop.id, { reason: "Oops", actor: null })),
    ).rejects.toThrow("cannot be undone");
  });
});
