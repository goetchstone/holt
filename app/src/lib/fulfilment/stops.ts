// /app/src/lib/fulfilment/stops.ts
//
// What a run stop's outcome does (ledger plan phase 20).
//
//   - Completed, delivery: the goods reached the customer. All of them is the
//     handover (handover.ts markHandedOver); some of them is a part delivery
//     (recordDelivery), and the rest goes back in the dispatch pool.
//   - Completed, return pickup: the return is picked up (returnPickup.ts).
//   - Could not deliver: nothing happened, so nothing is reversed. The stop
//     comes off the run and its appointment goes back in the dispatch pool;
//     the reason is written on the order. The units stay committed to the
//     order where they are (the loading bay) until a handheld move puts them
//     back, or the next run takes them.
//
// Completing is done once: the stop is claimed (status set to COMPLETED where
// it was not) before anything follows from it, so a driver's retry, or two
// taps racing, cannot hand the same goods over twice.

import type { Prisma } from "@prisma/client";
import {
  markHandedOver,
  recordDelivery,
  type DeliveredLine,
  type DeliveryResult,
} from "./handover";
import { completeReturnPickup } from "./returnPickup";

type Tx = Prisma.TransactionClient;

export class StopError extends Error {}

export interface StopCompletion {
  /** False when the stop was already completed: nothing was done again. */
  claimed: boolean;
  delivery: DeliveryResult | null;
  pickedUp: boolean | null;
}

export async function completeStop(
  tx: Tx,
  stopId: number,
  args: { at: Date; delivered?: DeliveredLine[] | null; actor: string | null },
): Promise<StopCompletion> {
  const claim = await tx.deliveryStop.updateMany({
    where: { id: stopId, status: { not: "COMPLETED" } },
    data: { status: "COMPLETED", completedAt: args.at },
  });
  if (claim.count === 0) return { claimed: false, delivery: null, pickedUp: null };

  const stop = await tx.deliveryStop.findUniqueOrThrow({
    where: { id: stopId },
    select: {
      serviceAppointment: {
        select: { id: true, type: true, salesOrderId: true, returnId: true },
      },
    },
  });
  const appt = stop.serviceAppointment;
  if (appt.type === "RETURN_PICKUP") {
    if (appt.returnId == null) throw new StopError("This pickup stop has no return.");
    const r = await completeReturnPickup(tx, {
      appointmentId: appt.id,
      returnId: appt.returnId,
      at: args.at,
      actor: args.actor,
    });
    return { claimed: true, delivery: null, pickedUp: r.pickedUp };
  }

  const handover = {
    salesOrderId: appt.salesOrderId,
    at: args.at,
    method: "DELIVERY" as const,
    actor: args.actor ?? "dispatch",
  };
  if (args.delivered) {
    const delivery = await recordDelivery(tx, {
      ...handover,
      lines: args.delivered,
      appointmentId: appt.id,
    });
    return { claimed: true, delivery, pickedUp: null };
  }
  // Completing a stop IS the handover. Until this, a signed and photographed
  // delivery left the order untouched -- still ORDER, stock still committed,
  // money still a deposit.
  const r = await markHandedOver(tx, handover);
  return {
    claimed: true,
    delivery: { changed: r.changed, complete: true, restAppointmentId: null },
    pickedUp: null,
  };
}

/** The stop could not be done: off the run, back in the pool, reason recorded. */
export async function failStop(
  tx: Tx,
  stopId: number,
  args: { reason: string; actor: string | null },
): Promise<{ appointmentId: number }> {
  const reason = args.reason.trim();
  if (!reason) throw new StopError("Say why it could not be done.");
  if (reason.length > 500) throw new StopError("Keep the reason under 500 characters.");
  const stop = await tx.deliveryStop.findUnique({
    where: { id: stopId },
    select: {
      status: true,
      deliveryRun: { select: { runNumber: true } },
      serviceAppointment: {
        select: { id: true, type: true, salesOrderId: true, returnId: true, notes: true },
      },
    },
  });
  if (!stop) throw new StopError("Stop not found.");
  if (stop.status === "COMPLETED") throw new StopError("A completed stop cannot be undone.");

  const appt = stop.serviceAppointment;
  const line = `Could not ${appt.type === "RETURN_PICKUP" ? "collect" : "deliver"} on run ${stop.deliveryRun.runNumber}: ${reason}`;
  await tx.deliveryStop.delete({ where: { id: stopId } });
  await tx.serviceAppointment.update({
    where: { id: appt.id },
    data: { notes: appt.notes ? `${appt.notes}\n${line}` : line, updatedBy: args.actor },
  });
  if (appt.type === "RETURN_PICKUP" && appt.returnId != null) {
    const ret = await tx.return.findUnique({
      where: { id: appt.returnId },
      select: { pickupNotes: true },
    });
    await tx.return.update({
      where: { id: appt.returnId },
      data: {
        pickupNotes: ret?.pickupNotes ? `${ret.pickupNotes}\n${line}` : line,
        updatedBy: args.actor,
      },
    });
  }
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: appt.salesOrderId,
      changeType: appt.type === "RETURN_PICKUP" ? "RETURN_PICKUP_FAILED" : "DELIVERY_FAILED",
      newValue: line,
      changedBy: args.actor ?? "dispatch",
    },
  });
  return { appointmentId: appt.id };
}
