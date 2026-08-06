// /app/src/pages/api/admin/inventory-exceptions/index.ts
//
// The oversell queue. Every InventoryException row is a shortfall
// `allocate()` (src/lib/inventory/allocation.ts) recorded when a sale went
// through with less free stock than requested -- allocation never blocks or
// warns the register, so this is the durable record that lands the gap
// somewhere back office can see it and work it. Lists unresolved rows by
// default; ?includeResolved=true also returns handled ones.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export interface InventoryExceptionRow {
  id: number;
  salesOrderId: number;
  orderno: string;
  productId: number;
  productName: string;
  partNo: string | null;
  storeLocationId: number;
  storeLocationName: string;
  requested: number;
  allocated: number;
  shortfall: number;
  occurredAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface InventoryExceptionsResponse {
  exceptions: InventoryExceptionRow[];
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const includeResolved = req.query.includeResolved === "true";

      const rows = await prisma.inventoryException.findMany({
        where: includeResolved ? undefined : { resolvedAt: null },
        include: {
          salesOrder: { select: { orderno: true } },
          product: { select: { name: true, productNumber: true } },
          storeLocation: { select: { name: true } },
        },
        orderBy: { occurredAt: "desc" },
      });

      const exceptions: InventoryExceptionRow[] = rows.map((r) => ({
        id: r.id,
        salesOrderId: r.salesOrderId,
        orderno: r.salesOrder.orderno,
        productId: r.productId,
        productName: r.product.name,
        partNo: r.product.productNumber,
        storeLocationId: r.storeLocationId,
        storeLocationName: r.storeLocation.name,
        requested: r.requested,
        allocated: r.allocated,
        shortfall: r.shortfall,
        occurredAt: r.occurredAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        resolvedBy: r.resolvedBy,
        resolutionNote: r.resolutionNote,
      }));

      const body: InventoryExceptionsResponse = { exceptions };
      return res.status(200).json(body);
    } catch (err) {
      logError("/api/admin/inventory-exceptions failed", err);
      return res.status(500).json({ error: "Failed to load inventory exceptions" });
    }
  },
);
