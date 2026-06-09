// /app/src/pages/api/returns/[id]/status.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { isValidTransition } from "@/lib/returnService";
import type { ReturnStatus } from "@prisma/client";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid return ID" });

  const { status: newStatus, ...fields } = req.body;
  if (!newStatus) return res.status(400).json({ error: "status is required" });

  const changedBy = session.user?.email || null;

  try {
    const ret = await prisma.return.findUniqueOrThrow({ where: { id } });

    if (!isValidTransition(ret.status, newStatus as ReturnStatus)) {
      return res.status(400).json({
        error: `Cannot transition from ${ret.status} to ${newStatus}`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updateData: any = {
        status: newStatus,
        updatedBy: changedBy,
      };

      // Side effects per transition
      switch (newStatus) {
        case "PICKUP_SCHEDULED":
          if (fields.pickupDate) updateData.pickupDate = new Date(fields.pickupDate);
          if (fields.pickupTimeSlot) updateData.pickupTimeSlot = fields.pickupTimeSlot;
          if (fields.pickupNotes) updateData.pickupNotes = fields.pickupNotes;
          if (fields.pickupAddressId)
            updateData.pickupAddressId = Number.parseInt(fields.pickupAddressId);
          break;

        case "RECEIVED":
          updateData.receivedAt = new Date();
          if (fields.receivedById) updateData.receivedById = Number.parseInt(fields.receivedById);
          if (fields.receivedLocationId)
            updateData.receivedLocationId = Number.parseInt(fields.receivedLocationId);
          break;

        case "INSPECTED":
          updateData.inspectedAt = new Date();
          if (fields.inspectedById)
            updateData.inspectedById = Number.parseInt(fields.inspectedById);
          if (fields.inspectionCondition)
            updateData.inspectionCondition = fields.inspectionCondition;
          if (fields.inspectionNotes) updateData.inspectionNotes = fields.inspectionNotes;
          break;

        case "RESTOCKED":
          updateData.restockedAt = new Date();
          if (fields.restockedLocationId)
            updateData.restockedLocationId = Number.parseInt(fields.restockedLocationId);
          // Increment inventory if product and location provided
          if (ret.productId && fields.restockedLocationId) {
            const storeLocationId = Number.parseInt(fields.restockedLocationId);
            await tx.inventoryPosition.upsert({
              where: {
                productId_storeLocationId_stockLocationId_salesOrderId: {
                  productId: ret.productId,
                  storeLocationId,
                  stockLocationId: null as unknown as number,
                  salesOrderId: null as unknown as number,
                },
              },
              update: { quantity: { increment: ret.quantity } },
              create: {
                productId: ret.productId,
                storeLocationId,
                quantity: ret.quantity,
              },
            });
          }
          break;

        case "WRITTEN_OFF":
          if (fields.writeOffReason) updateData.writeOffReason = fields.writeOffReason;
          break;

        case "CANCELLED":
          break;
      }

      const updated = await tx.return.update({
        where: { id },
        data: updateData,
      });

      // Audit log
      await tx.orderChangeLog.create({
        data: {
          salesOrderId: ret.salesOrderId,
          lineItemId: ret.lineItemId,
          changeType: `RETURN_${newStatus}`,
          previousValue: ret.status,
          newValue: newStatus,
          reason: fields.reason || undefined,
          changedBy,
        },
      });

      return updated;
    });

    return res.status(200).json(result);
  } catch (error) {
    logError("Error updating return status", error);
    return res.status(500).json({ error: "Failed to update return status" });
  }
}
