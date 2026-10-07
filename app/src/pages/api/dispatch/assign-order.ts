// /app/src/pages/api/dispatch/assign-order.ts
//
// Assigns a sales order to a delivery run. Auto-creates a DELIVERY
// ServiceAppointment and DeliveryStop in one transaction. Used by the
// dispatch board drag-and-drop.

import type { NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { assignOrderToRun } from "@/lib/deliveryService";

export default requireAuthWithRole(["MANAGER", "ADMIN", "WAREHOUSE"], async (req, res, session) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { salesOrderId, runId } = req.body;

  if (!salesOrderId || !runId) {
    return res.status(400).json({ error: "salesOrderId and runId are required" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.deliveryRun.findUnique({
        where: { id: runId },
        select: { id: true, runDate: true },
      });
      if (!run) throw new Error("Run not found");

      return assignOrderToRun(tx, {
        salesOrderId,
        runId: run.id,
        runDate: run.runDate,
        createdBy: session.user?.email ?? null,
      });
    }, TX_TIMEOUT.SHORT);

    logger.info("Assigned order to delivery run", {
      salesOrderId,
      runId,
      stopId: result.stopId,
    });

    return res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message.includes("not found") || err.message.includes("already assigned")) {
        return res.status(400).json({ error: err.message });
      }
    }
    logError("Failed to assign order to run", err);
    return res.status(500).json({ error: "Failed to assign order to run" });
  }
});
