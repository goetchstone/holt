// /app/src/pages/api/warehouse/transfers/[id]/status.ts
//
// Advances transfer status and adjusts InventoryPositions in a transaction.
// DRAFT -> IN_TRANSIT: decrements source position
// IN_TRANSIT -> RECEIVED: increments destination position
// Any -> CANCELLED: reverses any position changes already applied

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["RECEIVED", "CANCELLED"],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  // Advancing transfer status moves inventory between stores. Warehouse
  // staff and their managers only.
  const role = (session as unknown as { role?: string })?.role;
  if (role !== "WAREHOUSE" && role !== "MANAGER" && role !== "ADMIN") {
    return res.status(403).json({ error: "Warehouse, Manager, or Admin role required" });
  }

  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Transfer ID is required." });
  }

  const transferId = Number.parseInt(id);
  const { status: newStatus } = req.body;

  if (!newStatus) {
    return res.status(400).json({ error: "New status is required." });
  }

  try {
    const transfer = await prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
    });

    if (!transfer) return res.status(404).json({ error: "Transfer not found." });

    const allowed = VALID_TRANSITIONS[transfer.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from ${transfer.status} to ${newStatus}.`,
      });
    }

    if (!transfer.fromLocationId || !transfer.toLocationId) {
      return res.status(400).json({
        error: "Transfer must have from and to location IDs for status changes.",
      });
    }

    await prisma.$transaction(async (tx) => {
      if (newStatus === "IN_TRANSIT") {
        // Decrement source position
        const sourcePosition = await tx.inventoryPosition.findFirst({
          where: {
            productId: transfer.productId,
            storeLocationId: transfer.fromLocationId!,
            stockLocationId: transfer.fromStockLocationId ?? null,
            salesOrderId: null,
          },
        });

        if (sourcePosition) {
          const newQty = sourcePosition.quantity - transfer.quantity;
          if (newQty <= 0) {
            await tx.inventoryPosition.delete({ where: { id: sourcePosition.id } });
          } else {
            await tx.inventoryPosition.update({
              where: { id: sourcePosition.id },
              data: { quantity: newQty, updatedBy: session.user!.email },
            });
          }
        }

        await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: { status: "IN_TRANSIT", shippedAt: new Date() },
        });
      } else if (newStatus === "RECEIVED") {
        // Increment destination position
        await tx.inventoryPosition.upsert({
          where: {
            productId_storeLocationId_stockLocationId_salesOrderId: {
              productId: transfer.productId,
              storeLocationId: transfer.toLocationId!,
              stockLocationId: (transfer.toStockLocationId ?? null) as number,
              salesOrderId: null as unknown as number,
            },
          },
          update: {
            quantity: { increment: transfer.quantity },
            updatedBy: session.user!.email,
          },
          create: {
            productId: transfer.productId,
            storeLocationId: transfer.toLocationId!,
            stockLocationId: transfer.toStockLocationId ?? null,
            quantity: transfer.quantity,
            createdBy: session.user!.email,
          },
        });

        await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: {
            status: "RECEIVED",
            receivedAt: new Date(),
            receivedByUserId: session.user!.email,
          },
        });
      } else if (newStatus === "CANCELLED") {
        // Reverse changes if transfer was already in transit
        if (transfer.status === "IN_TRANSIT") {
          await tx.inventoryPosition.upsert({
            where: {
              productId_storeLocationId_stockLocationId_salesOrderId: {
                productId: transfer.productId,
                storeLocationId: transfer.fromLocationId!,
                stockLocationId: (transfer.fromStockLocationId ?? null) as number,
                salesOrderId: null as unknown as number,
              },
            },
            update: {
              quantity: { increment: transfer.quantity },
              updatedBy: session.user!.email,
            },
            create: {
              productId: transfer.productId,
              storeLocationId: transfer.fromLocationId!,
              stockLocationId: transfer.fromStockLocationId ?? null,
              quantity: transfer.quantity,
              createdBy: session.user!.email,
            },
          });
        }

        await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: { status: "CANCELLED" },
        });
      }
    });

    const updated = await prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
    });

    return res.status(200).json(updated);
  } catch (error) {
    logError("Error updating transfer status", error);
    return res.status(500).json({ error: "Failed to update transfer status" });
  }
}
