// /app/src/pages/api/service/house-calls/[id].ts

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

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid appointment ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["DESIGNER", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const appointment = await prisma.serviceAppointment.findUnique({
      where: { id },
      include: {
        salesOrder: { select: { id: true, orderno: true } },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        address: true,
        designer: { select: { id: true, displayName: true } },
        storeLocation: { select: { id: true, name: true } },
        lineItem: {
          select: {
            id: true,
            productName: true,
            partNo: true,
            netPrice: true,
            orderedQuantity: true,
          },
        },
        deliveryZone: true,
      },
    });

    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    return res.status(200).json({
      ...appointment,
      lineItem: appointment.lineItem
        ? {
            ...appointment.lineItem,
            netPrice: Number(appointment.lineItem.netPrice),
            orderedQuantity: Number(appointment.lineItem.orderedQuantity),
          }
        : null,
      deliveryZone: appointment.deliveryZone
        ? {
            ...appointment.deliveryZone,
            baseFee: Number(appointment.deliveryZone.baseFee),
            perPieceFee: appointment.deliveryZone.perPieceFee
              ? Number(appointment.deliveryZone.perPieceFee)
              : null,
          }
        : null,
    });
  } catch (error) {
    logError("Error fetching house call", error);
    return res.status(500).json({ error: "Failed to fetch house call" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  const {
    scheduledDate,
    scheduledTime,
    estimatedDuration,
    designerId,
    storeLocationId,
    scopeOfWork,
    notes,
    accessInstructions,
    deliveryZoneId,
    urgency,
    department,
    status: newStatus,
  } = req.body;

  try {
    const updateData: any = {
      updatedBy,
    };

    if (scheduledDate !== undefined)
      updateData.scheduledDate = scheduledDate ? new Date(scheduledDate) : null;
    if (scheduledTime !== undefined) updateData.scheduledTime = scheduledTime;
    if (estimatedDuration !== undefined)
      updateData.estimatedDuration = estimatedDuration ? Number.parseInt(estimatedDuration) : null;
    if (designerId !== undefined)
      updateData.designerId = designerId ? Number.parseInt(designerId) : null;
    if (storeLocationId !== undefined)
      updateData.storeLocationId = storeLocationId ? Number.parseInt(storeLocationId) : null;
    if (scopeOfWork !== undefined) updateData.scopeOfWork = scopeOfWork;
    if (notes !== undefined) updateData.notes = notes;
    if (accessInstructions !== undefined) updateData.accessInstructions = accessInstructions;
    if (deliveryZoneId !== undefined)
      updateData.deliveryZoneId = deliveryZoneId ? Number.parseInt(deliveryZoneId) : null;
    if (urgency !== undefined) updateData.urgency = urgency;
    if (department !== undefined) updateData.department = department;

    // Handle status transition if provided
    if (newStatus) {
      const current = await prisma.serviceAppointment.findUniqueOrThrow({ where: { id } });

      if (!isValidTransition(current.status, newStatus as ServiceAppointmentStatus)) {
        return res.status(400).json({
          error: `Cannot transition from ${current.status} to ${newStatus}`,
        });
      }

      updateData.status = newStatus;

      if (newStatus === "COMPLETED") {
        updateData.completedAt = new Date();
      }
    }

    const appointment = await prisma.serviceAppointment.update({
      where: { id },
      data: updateData,
    });

    return res.status(200).json(appointment);
  } catch (error) {
    logError("Error updating house call", error);
    return res.status(500).json({ error: "Failed to update house call" });
  }
}
