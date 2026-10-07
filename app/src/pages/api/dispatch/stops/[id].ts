// /app/src/pages/api/dispatch/stops/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { isValidStopTransition } from "@/lib/deliveryService";
import { markHandedOver } from "@/lib/fulfilment/handover";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid stop ID" });

  const { status, notes, estimatedArrival, actualArrival, recipientName } = req.body;

  try {
    const existing = await prisma.deliveryStop.findUnique({
      where: { id },
      select: {
        status: true,
        serviceAppointment: { select: { salesOrderId: true } },
      },
    });
    if (!existing) return res.status(404).json({ error: "Stop not found" });

    // The status used to be assigned unchecked, so PENDING -> COMPLETED was
    // accepted with no arrival and no proof. `completedAt` is the revenue date
    // now, so it has to be defensible.
    if (status !== undefined && status !== existing.status) {
      if (!isValidStopTransition(existing.status, status)) {
        return res.status(400).json({
          error: `Cannot move a stop from ${existing.status} to ${status}`,
        });
      }
    }

    const data: Record<string, unknown> = {
      notes: notes !== undefined ? notes : undefined,
      estimatedArrival: estimatedArrival !== undefined ? new Date(estimatedArrival) : undefined,
      actualArrival: actualArrival !== undefined ? new Date(actualArrival) : undefined,
      recipientName: recipientName !== undefined ? recipientName : undefined,
    };

    const handedOverAt = new Date();
    if (status !== undefined) {
      data.status = status;
      if (status === "ARRIVED" && !actualArrival) data.actualArrival = handedOverAt;
      if (status === "COMPLETED") data.completedAt = handedOverAt;
      // Back on the queue: a stop that could not be delivered has no completion.
      if (status === "PENDING") data.completedAt = null;
    }

    const isHandover = status === "COMPLETED" && existing.status !== "COMPLETED";
    const orderId = existing.serviceAppointment?.salesOrderId ?? null;

    const stop = await prisma.$transaction(async (tx) => {
      const updated = await tx.deliveryStop.update({
        where: { id },
        data,
        include: {
          serviceAppointment: {
            include: {
              customer: true,
              address: true,
            },
          },
        },
      });

      // Completing the stop IS the handover. Until this, a signed and
      // photographed delivery left the order untouched -- still ORDER, stock
      // still committed, money still a deposit.
      if (isHandover && orderId != null) {
        await markHandedOver(tx, {
          salesOrderId: orderId,
          at: handedOverAt,
          method: "DELIVERY",
          actor: "dispatch",
        });
      }

      return updated;
    });

    return res.status(200).json(stop);
  } catch (error) {
    logError("Error updating stop", error);
    return res.status(500).json({ error: "Failed to update stop" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN", "WAREHOUSE"], handler);
