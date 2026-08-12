// /app/src/pages/api/warehouse/transfers/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { success, badRequest, notFound, methodNotAllowed, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const transferId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(transferId)) return badRequest(res, "Invalid transfer ID");

  if (req.method === "GET") {
    try {
      const transfer = await prisma.inventoryTransfer.findUnique({
        where: { id: transferId },
        include: {
          product: { select: { id: true, name: true, productNumber: true } },
          fromStoreLocation: { select: { id: true, name: true, code: true } },
          toStoreLocation: { select: { id: true, name: true, code: true } },
          fromStockLocation: { select: { id: true, code: true, name: true } },
          toStockLocation: { select: { id: true, code: true, name: true } },
          requestedByUser: { select: { name: true, email: true } },
        },
      });

      if (!transfer) return notFound(res, "Transfer");

      return success(res, {
        id: transfer.id,
        productId: transfer.productId,
        productName: transfer.product.name,
        productNumber: transfer.product.productNumber,
        quantity: transfer.quantity,
        fromLocation: transfer.fromStoreLocation?.name || transfer.fromLocation,
        fromLocationId: transfer.fromLocationId,
        fromStockLocation: transfer.fromStockLocation?.name || null,
        fromStockLocationId: transfer.fromStockLocationId,
        toLocation: transfer.toStoreLocation?.name || transfer.toLocation,
        toLocationId: transfer.toLocationId,
        toStockLocation: transfer.toStockLocation?.name || null,
        toStockLocationId: transfer.toStockLocationId,
        status: transfer.status,
        notes: transfer.notes,
        requestedBy: transfer.requestedByUser.name || transfer.requestedByUser.email,
        shippedAt: transfer.shippedAt,
        receivedAt: transfer.receivedAt,
        receivedByUserId: transfer.receivedByUserId,
        created: transfer.created,
        updated: transfer.updated,
      });
    } catch (err) {
      return handleError(res, err, "GET /warehouse/transfers/[id]");
    }
  }

  return methodNotAllowed(res, ["GET"]);
}

// Detail read of the transfer rows transfers/index.ts lists and
// transfers/[id]/status.ts advances — same capability as both.
export default requirePermission("inventory.transfer", handler);
