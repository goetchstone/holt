// /app/src/pages/api/warehouse/dashboard/summary.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [locations, positionsByLocation, transfersInTransit, pendingDispatch] = await Promise.all(
      [
        prisma.storeLocation.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            name: true,
            code: true,
            type: true,
            stockLocations: {
              where: { isActive: true },
              orderBy: { sortOrder: "asc" },
              select: { id: true, code: true, name: true },
            },
          },
        }),

        prisma.inventoryPosition.groupBy({
          by: ["storeLocationId", "stockLocationId"],
          _sum: { quantity: true },
        }),

        prisma.inventoryTransfer.count({
          where: { status: "IN_TRANSIT" },
        }),

        prisma.salesOrder.count({
          where: {
            dispatchStatus: { in: ["PO_PLACED", "RECEIVED_IN_WAREHOUSE"] },
          },
        }),
      ],
    );

    // Build per-location summaries with stock location breakdowns
    const locationSummaries = locations.map((loc) => {
      const locPositions = positionsByLocation.filter((p) => p.storeLocationId === loc.id);
      const stockLocationBreakdown: Record<string, { name: string; quantity: number }> = {};
      let totalItems = 0;

      for (const p of locPositions) {
        const qty = p._sum.quantity || 0;
        totalItems += qty;

        const slId = String(p.stockLocationId || "unassigned");
        const sl = loc.stockLocations.find((s) => s.id === p.stockLocationId);
        const slName = sl?.name || "Unassigned";

        if (stockLocationBreakdown[slId]) {
          stockLocationBreakdown[slId].quantity += qty;
        } else {
          stockLocationBreakdown[slId] = { name: slName, quantity: qty };
        }
      }

      return {
        id: loc.id,
        name: loc.name,
        code: loc.code,
        type: loc.type,
        totalItems,
        stockLocationBreakdown,
      };
    });

    return res.status(200).json({
      locations: locationSummaries,
      transfersInTransit,
      pendingDispatch,
    });
  } catch (error) {
    logError("Error fetching dashboard summary", error);
    return res.status(500).json({ error: "Failed to fetch dashboard summary" });
  }
}
