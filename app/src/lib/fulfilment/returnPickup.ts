// /app/src/lib/fulfilment/returnPickup.ts
//
// A customer's return collected on a delivery run (ledger plan phase 20). The
// pickup is a stop like any other -- a RETURN_PICKUP ServiceAppointment with
// its DeliveryStop -- so the driver sees it in order and proves it the same
// way. What completing it means is different: the piece is on the truck, the
// Return moves to PICKUP_COMPLETED, and it is received into the store's
// returns place when the truck is back (lib/returnService.ts). It is never a
// handover, and its order's lines are not on the run's pull list.

import type { Prisma } from "@prisma/client";
import { generateAppointmentNumber } from "@/lib/serviceDispatchService";

type Tx = Prisma.TransactionClient;

export class ReturnPickupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const SCHEDULABLE = ["INITIATED", "PICKUP_SCHEDULED"] as const;

/** Put a return's pickup on a run as its last stop. */
export async function scheduleReturnPickup(
  tx: Tx,
  args: { returnId: number; deliveryRunId: number; actor: string | null },
): Promise<{ stopId: number; appointmentId: number }> {
  const ret = await tx.return.findUnique({
    where: { id: args.returnId },
    select: {
      id: true,
      returnNumber: true,
      status: true,
      pickupRequired: true,
      salesOrderId: true,
      customerId: true,
      pickupAddressId: true,
      pickupNotes: true,
      pickupAppointment: {
        select: {
          id: true,
          deliveryStop: { select: { deliveryRun: { select: { runNumber: true } } } },
        },
      },
    },
  });
  if (!ret) throw new ReturnPickupError("Return not found.", 404);
  if (!ret.pickupRequired) {
    throw new ReturnPickupError(`${ret.returnNumber} is not waiting for a pickup.`);
  }
  if (!(SCHEDULABLE as readonly string[]).includes(ret.status)) {
    throw new ReturnPickupError(
      `${ret.returnNumber} is ${ret.status.toLowerCase().replace("_", " ")}; its pickup cannot be scheduled.`,
    );
  }
  const onRun = ret.pickupAppointment?.deliveryStop?.deliveryRun.runNumber;
  if (onRun) throw new ReturnPickupError(`${ret.returnNumber} is already on run ${onRun}.`, 409);

  const run = await tx.deliveryRun.findUnique({
    where: { id: args.deliveryRunId },
    select: { status: true, runNumber: true, runDate: true },
  });
  if (!run) throw new ReturnPickupError("Delivery run not found.", 404);
  if (run.status === "COMPLETED") {
    throw new ReturnPickupError(`Run ${run.runNumber} is completed.`);
  }

  // A pickup that failed before keeps its appointment; it goes on a run again.
  const appointmentId =
    ret.pickupAppointment?.id ??
    (
      await tx.serviceAppointment.create({
        data: {
          appointmentNumber: await generateAppointmentNumber(),
          type: "RETURN_PICKUP",
          status: "SCHEDULED",
          salesOrderId: ret.salesOrderId,
          returnId: ret.id,
          customerId: ret.customerId,
          addressId: ret.pickupAddressId,
          scheduledDate: run.runDate,
          notes: ret.pickupNotes,
          createdBy: args.actor,
        },
        select: { id: true },
      })
    ).id;

  const last = await tx.deliveryStop.findFirst({
    where: { deliveryRunId: args.deliveryRunId },
    orderBy: { stopOrder: "desc" },
    select: { stopOrder: true },
  });
  const stop = await tx.deliveryStop.create({
    data: {
      deliveryRunId: args.deliveryRunId,
      serviceAppointmentId: appointmentId,
      stopOrder: (last?.stopOrder ?? 0) + 1,
    },
    select: { id: true },
  });

  await tx.return.update({
    where: { id: ret.id },
    data: { status: "PICKUP_SCHEDULED", pickupDate: run.runDate, updatedBy: args.actor },
  });
  return { stopId: stop.id, appointmentId };
}

/** The driver has the piece: the return is picked up. */
export async function completeReturnPickup(
  tx: Tx,
  args: { appointmentId: number; returnId: number; at: Date; actor: string | null },
): Promise<{ pickedUp: boolean }> {
  const r = await tx.return.updateMany({
    where: { id: args.returnId, status: { in: [...SCHEDULABLE] } },
    data: { status: "PICKUP_COMPLETED", updatedBy: args.actor },
  });
  await tx.serviceAppointment.update({
    where: { id: args.appointmentId },
    data: { status: "COMPLETED", completedAt: args.at, updatedBy: args.actor },
  });
  return { pickedUp: r.count > 0 };
}
