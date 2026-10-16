// /app/src/pages/api/warehouse/returns/returned-stock.ts
//
// A store's returned-stock queue: every returned piece that came back into the
// store's returns place and has been neither put back nor written off
// (lib/inventory/returnStock.ts). The customer's return may already be closed;
// the queue is about the piece, not the paperwork. ?storeLocationId= narrows
// it to one store.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { toQty } from "@/lib/inventory/quantity";
import { returnedStockQueueWhere } from "@/lib/inventory/returnStock";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const storeLocationId = req.query.storeLocationId ? Number(req.query.storeLocationId) : null;
  if (storeLocationId != null && !Number.isInteger(storeLocationId)) {
    return res.status(400).json({ error: "storeLocationId must be a store id." });
  }

  try {
    const rows = await prisma.return.findMany({
      where: returnedStockQueueWhere(storeLocationId),
      orderBy: { receivedAt: "asc" },
      select: {
        id: true,
        returnNumber: true,
        status: true,
        productId: true,
        productName: true,
        partNo: true,
        quantity: true,
        receivedAt: true,
        inspectionCondition: true,
        inspectionNotes: true,
        receivedLocationId: true,
        receivedLocation: { select: { name: true } },
        receivedStockLocation: { select: { name: true } },
        salesOrder: { select: { orderno: true } },
      },
    });
    return res.status(200).json({
      items: rows.map((r) => ({
        id: r.id,
        returnNumber: r.returnNumber,
        status: r.status,
        productId: r.productId,
        productName: r.productName,
        partNo: r.partNo,
        quantity: toQty(r.quantity),
        receivedAt: r.receivedAt,
        inspectionCondition: r.inspectionCondition,
        inspectionNotes: r.inspectionNotes,
        storeLocationId: r.receivedLocationId,
        storeName: r.receivedLocation?.name ?? null,
        placeName: r.receivedStockLocation?.name ?? null,
        orderno: r.salesOrder.orderno,
      })),
    });
  } catch (error) {
    logError("Error loading the returned-stock queue", error);
    return res.status(500).json({ error: "Failed to load returned stock" });
  }
}

// Returns staff and warehouse staff both work this queue.
export default requirePermission({ anyOf: ["sales.return", "inventory.transfer"] }, handler);
