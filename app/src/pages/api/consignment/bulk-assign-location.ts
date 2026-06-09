// /app/src/pages/api/consignment/bulk-assign-location.ts
//
// Assigns a store location to a set of ConsignmentItems.
// Manager-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN")
      return res.status(403).json({ error: "Manager role required" });

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
