// /app/src/pages/api/dispatch/stops/[id].ts
//
// PUT { status?, notes?, estimatedArrival?, actualArrival?, recipientName?,
//       delivered?: [{ orderLineItemId, quantity }] }
//     Moves a stop along. COMPLETED is the outcome (lib/fulfilment/stops.ts):
//     the handover, a part delivery when `delivered` leaves some behind, or a
//     return picked up.
// PUT { failReason }
//     The stop could not be done: it comes off the run and its appointment
//     goes back in the dispatch pool, with the reason on the order.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { isValidStopTransition } from "@/lib/deliveryService";
import { DeliveryError, type DeliveredLine } from "@/lib/fulfilment/handover";
import { completeStop, failStop, StopError } from "@/lib/fulfilment/stops";

function parseDelivered(value: unknown): DeliveredLine[] | null | Error {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return new Error("delivered must be a list of lines.");
  const lines: DeliveredLine[] = [];
  for (const v of value as Record<string, unknown>[]) {
    const orderLineItemId = Number(v?.orderLineItemId);
    const quantity = Number(v?.quantity);
    if (!Number.isInteger(orderLineItemId) || !Number.isFinite(quantity)) {
      return new Error("Each delivered line needs an orderLineItemId and a quantity.");
    }
    lines.push({ orderLineItemId, quantity });
  }
  return lines;
}

async function handleFail(id: number, failReason: unknown, actor: string, res: NextApiResponse) {
  if (typeof failReason !== "string") {
    return res.status(400).json({ error: "failReason must be text." });
  }
  const failed = await prisma.$transaction((tx) => failStop(tx, id, { reason: failReason, actor }));
  return res.status(200).json({ removed: true, ...failed });
}

async function handleUpdate(id: number, req: NextApiRequest, res: NextApiResponse, actor: string) {
  const { status, notes, estimatedArrival, actualArrival, recipientName } = req.body;
  const delivered = parseDelivered(req.body.delivered);
  if (delivered instanceof Error) return res.status(400).json({ error: delivered.message });

  const existing = await prisma.deliveryStop.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!existing) return res.status(404).json({ error: "Stop not found" });

  // The status used to be assigned unchecked, so PENDING -> COMPLETED was
  // accepted with no arrival and no proof. `completedAt` is the revenue date
  // now, so it has to be defensible.
  if (
    status !== undefined &&
    status !== existing.status &&
    !isValidStopTransition(existing.status, status)
  ) {
    return res
      .status(400)
      .json({ error: `Cannot move a stop from ${existing.status} to ${status}` });
  }

  const data: Record<string, unknown> = {
    notes: notes ?? undefined,
    estimatedArrival: estimatedArrival !== undefined ? new Date(estimatedArrival) : undefined,
    actualArrival: actualArrival !== undefined ? new Date(actualArrival) : undefined,
    recipientName: recipientName ?? undefined,
  };

  const now = new Date();
  // COMPLETED is set by completeStop, which claims the stop first.
  if (status !== undefined && status !== "COMPLETED") {
    data.status = status;
    if (status === "ARRIVED" && !actualArrival) data.actualArrival = now;
    // Back on the queue: a stop that could not be delivered has no completion.
    if (status === "PENDING") data.completedAt = null;
  }

  const stop = await prisma.$transaction(async (tx) => {
    const completion =
      status === "COMPLETED" ? await completeStop(tx, id, { at: now, delivered, actor }) : null;
    const updated = await tx.deliveryStop.update({
      where: { id },
      data,
      include: { serviceAppointment: { include: { customer: true, address: true } } },
    });
    return { ...updated, completion };
  });
  return res.status(200).json(stop);
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid stop ID" });
  const actor = session.user?.email || "dispatch";

  try {
    if (req.body?.failReason !== undefined) {
      return await handleFail(id, req.body.failReason, actor, res);
    }
    return await handleUpdate(id, req, res, actor);
  } catch (error) {
    if (error instanceof DeliveryError || error instanceof StopError) {
      return res.status(400).json({ error: error.message });
    }
    logError("Error updating stop", error);
    return res.status(500).json({ error: "Failed to update stop" });
  }
}

export default requirePermission("warehouse.operate", handler);
