// /app/src/pages/api/admin/inventory-exceptions/resolve.ts
//
// Mark an InventoryException handled -- back office has addressed the
// shortfall (received a PO, corrected a count, etc). Does not touch
// InventoryPosition or re-run allocation; it only clears the flag on the
// oversell queue. `resolutionNote` is optional.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requirePermission(
  "inventory.adjust",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const id = Number(req.body?.id);
    const resolutionNote =
      typeof req.body?.resolutionNote === "string" ? req.body.resolutionNote.trim() : undefined;

    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id is required" });
    }

    try {
      const existing = await prisma.inventoryException.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: "Inventory exception not found" });
      }

      const updated = await prisma.inventoryException.update({
        where: { id },
        data: {
          resolvedAt: new Date(),
          resolvedBy: session.user?.email || "unknown",
          resolutionNote: resolutionNote || null,
          updatedBy: session.user?.email || null,
        },
      });

      return res.status(200).json({ id: updated.id, resolvedAt: updated.resolvedAt });
    } catch (err) {
      logError("/api/admin/inventory-exceptions/resolve failed", err);
      return res.status(500).json({ error: "Failed to resolve inventory exception" });
    }
  },
);
