// /app/__tests__/integration/returnPickupStop.integration.test.ts
//
// A return's pickup as a run stop, against real Postgres
// (lib/fulfilment/returnPickup.ts, stops.ts): scheduling it makes the stop and
// moves the return to PICKUP_SCHEDULED, once; its order's lines are not on the
// run's pull list or pickable; completing it marks the return picked up and is
// never a handover; a pickup that could not be done keeps its appointment and
// goes on a run again.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { scheduleReturnPickup, ReturnPickupError } from "@/lib/fulfilment/returnPickup";
import { completeStop, failStop } from "@/lib/fulfilment/stops";
import { buildPullList } from "@/lib/fulfilment/pullList";
import { pickUnits, PickError } from "@/lib/fulfilment/pick";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const chair = await prisma.product.create({
    data: {
      productNumber: "CHAIR",
      name: "Chair",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const dock = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "DOCK", name: "Loading Bay", locationType: "STAGING" },
  });
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  const address = await prisma.customerAddress.create({
    data: { customerId: customer.id, address1: "1 Main", city: "Town", state: "CT", zip: "06000" },
  });
  // The order still has an open line: if the pickup stop's order counted as
  // one to deliver, it would show on the pull list as a line with no stock.
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
          { lineNumber: 1, productId: chair.id, orderedQuantity: 2, netPrice: 300, cost: 100 },
        ],
      },
    },
  });
  const ret = await prisma.return.create({
    data: {
      returnNumber: "RET-1",
      status: "INITIATED",
      reason: "DEFECTIVE",
      salesOrderId: order.id,
      customerId: customer.id,
      productId: chair.id,
      productName: "Chair",
      quantity: 1,
      pickupRequired: true,
      pickupAddressId: address.id,
      pickupNotes: "Side door",
    },
  });
  const vehicle = await prisma.vehicle.create({ data: { name: "Truck" } });
  const run = await prisma.deliveryRun.create({
    data: { runNumber: "RUN-1", runDate: new Date(), vehicleId: vehicle.id, status: "PLANNING" },
  });
  return { chair, store, dock, order, ret, run, vehicle };
}

const schedule = (returnId: number, deliveryRunId: number) =>
  prisma.$transaction((tx) => scheduleReturnPickup(tx, { returnId, deliveryRunId, actor: "d@x" }));

describe("return pickups on a run (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("scheduling makes the stop and schedules the return, once", async () => {
    const w = await world();
    const made = await schedule(w.ret.id, w.run.id);
    const appt = await prisma.serviceAppointment.findUniqueOrThrow({
      where: { id: made.appointmentId },
      include: { deliveryStop: true },
    });
    expect(appt).toMatchObject({
      type: "RETURN_PICKUP",
      returnId: w.ret.id,
      salesOrderId: w.order.id,
      addressId: w.ret.pickupAddressId,
      notes: "Side door",
    });
    expect(appt.deliveryStop?.deliveryRunId).toBe(w.run.id);
    const ret = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    expect(ret.status).toBe("PICKUP_SCHEDULED");

    await expect(schedule(w.ret.id, w.run.id)).rejects.toThrow("already on run RUN-1");
    await expect(schedule(w.ret.id, w.run.id)).rejects.toBeInstanceOf(ReturnPickupError);
  });

  it("its order's lines are not on the run's pull list, and cannot be picked for it", async () => {
    const w = await world();
    await schedule(w.ret.id, w.run.id);
    expect((await buildPullList(prisma, { deliveryRunId: w.run.id })).rows).toEqual([]);
    await expect(
      prisma.$transaction((tx) =>
        pickUnits(tx, {
          deliveryRunId: w.run.id,
          salesOrderId: w.order.id,
          productId: w.chair.id,
          units: 1,
          fromStockLocationId: w.dock.id,
          toStockLocationId: w.dock.id,
          actor: null,
        }),
      ),
    ).rejects.toThrow(PickError);
  });

  it("completing the stop picks the return up, and is never a handover", async () => {
    const w = await world();
    const made = await schedule(w.ret.id, w.run.id);
    const done = await prisma.$transaction((tx) =>
      completeStop(tx, made.stopId, { at: new Date(), actor: "d@x" }),
    );
    expect(done).toMatchObject({ claimed: true, delivery: null, pickedUp: true });
    const ret = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    expect(ret.status).toBe("PICKUP_COMPLETED");
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: w.order.id } });
    expect(order.deliveredAt).toBeNull();
    expect(order.status).toBe("ORDER");
    const appt = await prisma.serviceAppointment.findUniqueOrThrow({
      where: { id: made.appointmentId },
    });
    expect(appt.status).toBe("COMPLETED");
  });

  it("a pickup that could not be done keeps its appointment and goes on a run again", async () => {
    const w = await world();
    const made = await schedule(w.ret.id, w.run.id);
    await prisma.$transaction((tx) =>
      failStop(tx, made.stopId, { reason: "Gate locked", actor: "d@x" }),
    );
    const ret = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    expect(ret.status).toBe("PICKUP_SCHEDULED");
    expect(ret.pickupNotes).toBe("Side door\nCould not collect on run RUN-1: Gate locked");
    expect(
      await prisma.orderChangeLog.count({
        where: { salesOrderId: w.order.id, changeType: "RETURN_PICKUP_FAILED" },
      }),
    ).toBe(1);

    const run2 = await prisma.deliveryRun.create({
      data: {
        runNumber: "RUN-2",
        runDate: new Date(),
        vehicleId: w.vehicle.id,
        status: "PLANNING",
      },
    });
    const again = await schedule(w.ret.id, run2.id);
    expect(again.appointmentId).toBe(made.appointmentId);
    expect(await prisma.serviceAppointment.count({ where: { returnId: w.ret.id } })).toBe(1);
  });

  it("refuses a return that needs no pickup", async () => {
    const w = await world();
    await prisma.return.update({ where: { id: w.ret.id }, data: { pickupRequired: false } });
    await expect(schedule(w.ret.id, w.run.id)).rejects.toThrow("not waiting for a pickup");
  });
});
