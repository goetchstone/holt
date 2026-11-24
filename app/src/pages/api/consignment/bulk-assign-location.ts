// /app/src/pages/api/consignment/bulk-assign-location.ts
//
// Assigns a store location to a set of ConsignmentItems (Receiving Gaps'
// Assign Location). "Adjust inventory" alone decides who may. Until 2026-11 a
// second check also required the staff role to be MANAGER or ADMIN by name,
// which refused the Owner, the General Manager and every custom role.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

import { requirePermission } from "@/lib/auth/requireAuth";
export default requirePermission(
  "inventory.adjust",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { itemIds, storeLocationId } = req.body as {
      itemIds: number[];
      storeLocationId: number;
    };

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: "itemIds array is required" });
    }
    if (!storeLocationId) {
      return res.status(400).json({ error: "storeLocationId is required" });
    }

    const location = await prisma.storeLocation.findUnique({ where: { id: storeLocationId } });
    if (!location) return res.status(400).json({ error: "Store location not found" });

    const result = await prisma.consignmentItem.updateMany({
      where: { id: { in: itemIds } },
      data: { storeLocationId },
    });

    logger.info("Bulk consignment location assign", {
      storeLocationId,
      locationName: location.name,
      assigned: result.count,
      user: session.user.email,
    });

    return res.status(200).json({ assigned: result.count });
  },
);
