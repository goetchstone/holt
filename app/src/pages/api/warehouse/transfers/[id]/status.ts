// /app/src/pages/api/warehouse/transfers/[id]/status.ts
//
// Advances transfer status and adjusts InventoryPositions in a transaction.
// DRAFT -> IN_TRANSIT: decrements source position
// IN_TRANSIT -> RECEIVED: increments destination position
// Any -> CANCELLED: reverses any position changes already applied

import { NextApiRequest, NextApiResponse } from "next";
import { allocate } from "@/lib/inventory/allocation";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["RECEIVED", "CANCELLED"],
};

// Advancing transfer status moves inventory between stores. Warehouse staff
// and their managers only.
async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
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
        // Increment the destination position, or create it.
        //
        // NOT an upsert. InventoryPosition's unique key contains two NULLABLE
        // columns (stockLocationId, salesOrderId), and the index does not
        // declare NULLS NOT DISTINCT -- so Postgres treats every free-stock row
        // as distinct and the upsert's `where` could NEVER match one. Every
        // receipt created a NEW row instead of incrementing the existing one,
        // fragmenting free stock across duplicate rows for the same product,
        // store and bin. It lost no units, so nothing ever complained.
        //
        // The `null as unknown as number` cast the upsert needed to compile was
        // the tell: a cast that exists only to satisfy a key the value cannot
        // legally take means the operation is wrong. lib/inventory/allocation.ts
        // avoids the same trap in release(); this matches its shape.
        const destination = await tx.inventoryPosition.findFirst({
          where: {
            productId: transfer.productId,
            storeLocationId: transfer.toLocationId!,
            stockLocationId: transfer.toStockLocationId ?? null,
            salesOrderId: null,
          },
        });
        if (destination) {
          await tx.inventoryPosition.update({
            where: { id: destination.id },
            data: {
              quantity: { increment: transfer.quantity },
              updatedBy: session.user!.email,
            },
          });
        } else {
          await tx.inventoryPosition.create({
            data: {
              productId: transfer.productId,
              storeLocationId: transfer.toLocationId!,
              stockLocationId: transfer.toStockLocationId ?? null,
              quantity: transfer.quantity,
              createdBy: session.user!.email,
            },
          });
        }

        // The stock has landed at the destination store, so an order that was
        // waiting on it can finally hold it. Allocation is store-scoped, which
        // is the whole reason the transfer existed.
        //
        // Best-effort on purpose: the goods HAVE physically arrived, and a
        // receipt must not fail because the order was cancelled or already
        // filled from elsewhere while the stock was in transit. The transfer is
        // recorded either way and the order simply stays short, which the
        // shortfall queue already surfaces.
        if (transfer.salesOrderId) {
          try {
            await allocate(
              transfer.salesOrderId,
              [
                {
                  productId: transfer.productId,
                  storeLocationId: transfer.toLocationId!,
                  quantity: transfer.quantity,
                },
              ],
              tx,
            );
          } catch (err) {
            logError("Transfer received but allocating to its order failed", err, {
              transferId,
              salesOrderId: transfer.salesOrderId,
            });
          }
        }

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

export default requirePermission("inventory.transfer", handler);
