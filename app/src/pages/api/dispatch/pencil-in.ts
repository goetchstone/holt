// /app/src/pages/api/dispatch/pencil-in.ts
//
// Pencil-in a sales order for future delivery. POST creates/reuses a PLANNING
// run for the given date and assigns the order. DELETE removes the pencil-in
// by deleting the DeliveryStop and ServiceAppointment.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { assignOrderToRun, findOrCreatePlanningRun } from "@/lib/deliveryService";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req, res: NextApiResponse, session) => {
    if (req.method === "POST") {
      return handlePost(req, res, session.user?.email ?? null);
    }
    if (req.method === "DELETE") {
      return handleDelete(req, res);
    }

    res.setHeader("Allow", ["POST", "DELETE"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  },
);

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  const { salesOrderId, date } = req.body;

  if (!salesOrderId || !date) {
    return res.status(400).json({ error: "salesOrderId and date are required" });
  }

  const runDate = new Date(date);
  if (Number.isNaN(runDate.getTime())) {
    return res.status(400).json({ error: "Invalid date" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const run = await findOrCreatePlanningRun(tx, runDate, createdBy);
      const assignment = await assignOrderToRun(tx, {
        salesOrderId: Number(salesOrderId),
        runId: run.id,
        runDate: run.runDate,
        createdBy,
      });
      return { ...assignment, runDate: run.runDate.toISOString() };
    }, TX_TIMEOUT.SHORT);

    logger.info("Penciled in order for delivery", { salesOrderId, date, runDate: result.runDate });

    return res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message.includes("not found") || err.message.includes("already assigned")) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message.includes("No active vehicles")) {
        return res
          .status(400)
          .json({ error: "No active vehicles available. Add a vehicle first." });
      }
    }
    logError("Failed to pencil in order", err);
    return res.status(500).json({ error: "Failed to pencil in order" });
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const salesOrderId = Number(req.query.salesOrderId || req.body?.salesOrderId);

  if (!salesOrderId) {
    return res.status(400).json({ error: "salesOrderId is required" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Find the DELIVERY appointment on a PLANNING run
      const appointment = await tx.serviceAppointment.findFirst({
        where: {
          salesOrderId,
          type: "DELIVERY",
          deliveryStop: {
            deliveryRun: { status: "PLANNING" },
          },
        },
        select: {
          id: true,
          deliveryStop: { select: { id: true, deliveryRunId: true } },
        },
      });

      if (!appointment?.deliveryStop) {
        throw new Error("No penciled-in delivery found for this order");
      }

      // Delete stop first (FK constraint), then appointment
      await tx.deliveryStop.delete({ where: { id: appointment.deliveryStop.id } });
      await tx.serviceAppointment.delete({ where: { id: appointment.id } });

      return { removed: true, appointmentId: appointment.id };
    }, TX_TIMEOUT.SHORT);

    logger.info("Removed pencil-in for order", { salesOrderId });

    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("No penciled-in")) {
      return res.status(404).json({ error: err.message });
    }
    logError("Failed to remove pencil-in", err);
    return res.status(500).json({ error: "Failed to remove pencil-in" });
  }
}
