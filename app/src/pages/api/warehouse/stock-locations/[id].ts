// /app/src/pages/api/warehouse/stock-locations/[id].ts
//
// PUT/DELETE for individual stock location records.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const role = (session as any)?.role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return res.status(403).json({ error: "Manager role required" });
  }

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Stock location ID is required." });
  }

  const stockLocationId = Number.parseInt(id);
  if (Number.isNaN(stockLocationId)) {
    return res.status(400).json({ error: "Invalid stock location ID." });
  }

  if (req.method === "PUT") {
    try {
      const {
        code,
        name,
        description,
        building,
        floor,
        area,
        isActive,
        sortOrder,
        locationType,
        squareFootage,
        locationAliases,
      } = req.body;

      const stockLocation = await prisma.stockLocation.update({
        where: { id: stockLocationId },
        data: {
          ...(code !== undefined && { code }),
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description: description || null }),
          ...(building !== undefined && { building: building || null }),
          ...(floor !== undefined && { floor: floor != null ? Number.parseInt(floor) : null }),
          ...(area !== undefined && { area: area != null ? Number.parseInt(area) : null }),
          ...(isActive !== undefined && { isActive }),
          ...(sortOrder !== undefined && { sortOrder }),
          ...(locationType !== undefined && { locationType }),
          ...(squareFootage !== undefined && {
            squareFootage: squareFootage != null ? Number.parseInt(squareFootage) : null,
          }),
          ...(locationAliases !== undefined && {
            locationAliases: Array.isArray(locationAliases) ? locationAliases : [],
          }),
          updatedBy: session.user?.email || null,
        },
      });

      return res.status(200).json(stockLocation);
    } catch (error: unknown) {
      if (getErrorCode(error) === "P2002") {
        return res
          .status(409)
          .json({ error: "A stock location with that code already exists at this location." });
      }
      logError("Error updating stock location", error);
      return res.status(500).json({ error: "Failed to update stock location" });
    }
  }

  if (req.method === "DELETE") {
    try {
      // Check if any inventory positions reference this stock location
      const positionCount = await prisma.inventoryPosition.count({
        where: { stockLocationId },
      });

      if (positionCount > 0) {
        return res.status(400).json({
          error: `Cannot delete: ${positionCount} inventory position(s) reference this stock location. Deactivate instead.`,
        });
      }

      await prisma.stockLocation.delete({ where: { id: stockLocationId } });
      return res.status(200).json({ success: true });
    } catch (error) {
      logError("Error deleting stock location", error);
      return res.status(500).json({ error: "Failed to delete stock location" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
