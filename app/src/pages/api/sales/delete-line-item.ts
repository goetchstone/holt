// /app/src/pages/api/sales/delete-line-item.ts
//
// Deletes a specific order line item by ID. Manager-only.
// Used to clean up orphaned/duplicate lines from import issues.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

    const lineItemId = Number.parseInt((req.query.id as string) || req.body?.id, 10);
    if (Number.isNaN(lineItemId)) return res.status(400).json({ error: "id is required" });

    try {
      const line = await prisma.orderLineItem.findUnique({
        where: { id: lineItemId },
        select: { id: true, salesOrderId: true, partNo: true, lineNumber: true },
      });
      if (!line) return res.status(404).json({ error: "Line item not found" });

      await prisma.orderLineItem.delete({ where: { id: lineItemId } });

      return res.json({ deleted: true, lineItemId, orderId: line.salesOrderId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  },
);
