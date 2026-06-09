// /app/src/pages/api/service/dispatch/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
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
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
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
        installer: true,
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
    logError("Error fetching appointment", error);
    return res.status(500).json({ error: "Failed to fetch appointment" });
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
    installerId,
    estimatedDuration,
    notes,
    accessInstructions,
    deliveryZoneId,
    urgency,
    department,
  } = req.body;

  try {
    const appointment = await prisma.serviceAppointment.update({
      where: { id },
      data: {
        scheduledDate:
          scheduledDate !== undefined
            ? scheduledDate
              ? new Date(scheduledDate)
              : null
            : undefined,
        scheduledTime: scheduledTime !== undefined ? scheduledTime : undefined,
        installerId:
          installerId !== undefined
            ? installerId
              ? Number.parseInt(installerId)
              : null
            : undefined,
        estimatedDuration:
          estimatedDuration !== undefined
            ? estimatedDuration
              ? Number.parseInt(estimatedDuration)
              : null
            : undefined,
        notes: notes !== undefined ? notes : undefined,
        accessInstructions: accessInstructions !== undefined ? accessInstructions : undefined,
        deliveryZoneId:
          deliveryZoneId !== undefined
            ? deliveryZoneId
              ? Number.parseInt(deliveryZoneId)
              : null
            : undefined,
        urgency: urgency !== undefined ? urgency : undefined,
        department: department !== undefined ? department : undefined,
        updatedBy,
      },
    });

    return res.status(200).json(appointment);
  } catch (error) {
    logError("Error updating appointment", error);
    return res.status(500).json({ error: "Failed to update appointment" });
  }
}
