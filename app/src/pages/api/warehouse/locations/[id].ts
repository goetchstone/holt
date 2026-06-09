// /app/src/pages/api/warehouse/locations/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Location ID is required." });
  }

  const locationId = Number.parseInt(id);
  if (Number.isNaN(locationId)) {
    return res.status(400).json({ error: "Invalid location ID." });
  }

  if (req.method === "GET") {
    try {
      const location = await prisma.storeLocation.findUnique({
        where: { id: locationId },
        include: {
          stockLocations: {
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              code: true,
              name: true,
              description: true,
              building: true,
              floor: true,
              area: true,
              locationType: true,
              squareFootage: true,
              isActive: true,
              sortOrder: true,
            },
          },
        },
      });
      if (!location) return res.status(404).json({ error: "Location not found." });
      return res.status(200).json(location);
    } catch (error) {
      logError("Error fetching location", error);
      return res.status(500).json({ error: "Failed to fetch location" });
    }
  }

  if (req.method === "PUT") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Manager role required" });
    }

    try {
      const {
        name,
        code,
        type,
        address,
        city,
        state,
        zip,
        isActive,
        sortOrder,
        externalLocationName,
        defaultReceivingStockLocationId,
      } = req.body;

      const location = await prisma.storeLocation.update({
        where: { id: locationId },
        data: {
          ...(name !== undefined && { name }),
          ...(code !== undefined && { code: code.toUpperCase() }),
          ...(type !== undefined && { type }),
          ...(address !== undefined && { address }),
          ...(city !== undefined && { city }),
          ...(state !== undefined && { state }),
          ...(zip !== undefined && { zip }),
          ...(isActive !== undefined && { isActive }),
          ...(sortOrder !== undefined && { sortOrder: Number.parseInt(sortOrder) }),
          ...(externalLocationName !== undefined && {
            externalLocationName: externalLocationName || null,
          }),
          ...(defaultReceivingStockLocationId !== undefined && {
            defaultReceivingStockLocationId: defaultReceivingStockLocationId || null,
          }),
          updatedBy: session.user?.email || null,
        },
      });

      return res.status(200).json(location);
    } catch (error: unknown) {
      if (getErrorCode(error) === "P2002") {
        return res.status(409).json({ error: "A location with that name or code already exists." });
      }
      logError("Error updating location", error);
      return res.status(500).json({ error: "Failed to update location" });
    }
  }

  if (req.method === "DELETE") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Manager role required" });
    }

    try {
      await prisma.storeLocation.delete({ where: { id: locationId } });
      return res.status(200).json({ success: true });
    } catch (error: unknown) {
      if (getErrorCode(error) === "P2003") {
        return res.status(409).json({ error: "Cannot delete location with associated records." });
      }
      logError("Error deleting location", error);
      return res.status(500).json({ error: "Failed to delete location" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
