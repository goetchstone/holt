// /app/__tests__/integration/deliveryRunStatus.integration.test.ts
//
// Moving a delivery run along, against real Postgres (lib/fulfilment/runs.ts):
//
//   - a run with a stop still open is not completed, and nothing changes;
//   - once every stop is done it is, and completing it again is refused;
//   - a stop that could not be done comes off the run, so it does not hold the
//     run open;
//   - a run still being planned cannot be completed (owner decision #4 is
//     open; the route keeps refusing it until it is made);
//   - leaving for the first stop stamps departedAt.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { RunError, setRunStatus } from "@/lib/fulfilment/runs";
import { failStop } from "@/lib/fulfilment/stops";

async function world(runStatus: "PLANNING" | "LOADED" | "IN_PROGRESS" = "IN_PROGRESS") {
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  const vehicle = await prisma.vehicle.create({ data: { name: "Truck" } });
  const run = await prisma.deliveryRun.create({
    data: { runNumber: "RUN-1", runDate: new Date(), vehicleId: vehicle.id, status: runStatus },
  });
  const stopFor = async (n: number, status: "ARRIVED" | "COMPLETED") => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `SO-${n}`,
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: "Mill",
        storeLocationId: store.id,
        deliveryMethod: "DELIVERY",
      },
    });
    const appointment = await prisma.serviceAppointment.create({
      data: {
        appointmentNumber: `APPT-${n}`,
        type: "DELIVERY",
        status: "SCHEDULED",
        salesOrderId: order.id,
        customerId: customer.id,
        storeLocationId: store.id,
        scheduledDate: new Date(),
      },
    });
    return prisma.deliveryStop.create({
      data: {
        deliveryRunId: run.id,
        serviceAppointmentId: appointment.id,
        stopOrder: n,
        status,
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
    });
  };
  return { run, stopFor };
}

const move = (runId: number, status: Parameters<typeof setRunStatus>[2]) =>
  prisma.$transaction((tx) => setRunStatus(tx, runId, status, "lead@test"));

describe("moving a delivery run along", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("does not complete a run with a stop still open, and changes nothing", async () => {
    const { run, stopFor } = await world();
    await stopFor(1, "COMPLETED");
    await stopFor(2, "ARRIVED");

    await expect(move(run.id, "COMPLETED")).rejects.toThrow(
      new RunError(
        "Run RUN-1 has 1 stop still open. Complete each one, or mark it couldn't deliver, before completing the run.",
      ),
    );

    const after = await prisma.deliveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.completedAt).toBeNull();
  });

  it("completes a run once every stop is done, and only once", async () => {
    const { run, stopFor } = await world();
    await stopFor(1, "COMPLETED");
    await stopFor(2, "COMPLETED");

    const done = await move(run.id, "COMPLETED");
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).not.toBeNull();
    expect(done.updatedBy).toBe("lead@test");

    await expect(move(run.id, "COMPLETED")).rejects.toThrow(
      "Cannot move run RUN-1 from COMPLETED to COMPLETED.",
    );
  });

  it("lets a stop that could not be done stop holding the run open", async () => {
    const { run, stopFor } = await world();
    await stopFor(1, "COMPLETED");
    const stuck = await stopFor(2, "ARRIVED");
    await expect(move(run.id, "COMPLETED")).rejects.toThrow(RunError);

    await prisma.$transaction((tx) =>
      failStop(tx, stuck.id, { reason: "Nobody home", actor: "driver@test" }),
    );

    expect((await move(run.id, "COMPLETED")).status).toBe("COMPLETED");
  });

  it("does not complete a run that is still being planned, even with no stops", async () => {
    const { run } = await world("PLANNING");

    await expect(move(run.id, "COMPLETED")).rejects.toThrow(
      "Cannot move run RUN-1 from PLANNING to COMPLETED.",
    );
    expect((await prisma.deliveryRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "PLANNING",
    );
  });

  it("stamps departedAt when a loaded run leaves", async () => {
    const { run } = await world("LOADED");

    const left = await move(run.id, "IN_PROGRESS");
    expect(left.status).toBe("IN_PROGRESS");
    expect(left.departedAt).not.toBeNull();
    expect(left.completedAt).toBeNull();
  });

  it("answers a missing run as not found", async () => {
    await expect(move(999_999, "COMPLETED")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
