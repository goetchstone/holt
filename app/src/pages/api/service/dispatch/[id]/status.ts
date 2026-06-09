// /app/src/pages/api/service/dispatch/[id]/status.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { isValidTransition } from "@/lib/serviceDispatchService";
import type { ServiceAppointmentStatus } from "@prisma/client";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid appointment ID" });

  const { status: newStatus } = req.body;
  if (!newStatus) return res.status(400).json({ error: "status is required" });

  const changedBy = session.user?.email || null;

  try {
    const appointment = await prisma.serviceAppointment.findUniqueOrThrow({ where: { id } });

    if (!isValidTransition(appointment.status, newStatus as ServiceAppointmentStatus)) {
      return res.status(400).json({
        error: `Cannot transition from ${appointment.status} to ${newStatus}`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updateData: any = {
        status: newStatus,
        updatedBy: changedBy,
      };

      if (newStatus === "COMPLETED") {
        updateData.completedAt = new Date();
      }

      const updated = await tx.serviceAppointment.update({
        where: { id },
        data: updateData,
      });

      await tx.orderChangeLog.create({
        data: {
          salesOrderId: appointment.salesOrderId,
          lineItemId: appointment.lineItemId,
          changeType: `SERVICE_${newStatus}`,
          previousValue: appointment.status,
          newValue: newStatus,
          changedBy,
        },
      });

      return updated;
    });

    return res.status(200).json(result);
  } catch (error) {
    logError("Error updating appointment status", error);
    return res.status(500).json({ error: "Failed to update appointment status" });
  }
}
