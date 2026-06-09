// /app/src/pages/api/warehouse/locations/[id]/stock-locations.ts
//
// CRUD for StockLocations within a StoreLocation.

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

  const storeLocationId = Number.parseInt(id);
  if (Number.isNaN(storeLocationId)) {
    return res.status(400).json({ error: "Invalid location ID." });
  }

  if (req.method === "GET") {
    try {
      const stockLocations = await prisma.stockLocation.findMany({
        where: { storeLocationId },
        orderBy: { sortOrder: "asc" },
      });
      return res.status(200).json({ stockLocations });
    } catch (error) {
      logError("Error fetching stock locations", error);
      return res.status(500).json({ error: "Failed to fetch stock locations" });
    }
  }

  if (req.method === "POST") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Manager role required" });
    }

    try {
      const {
        code,
        name,
        description,
        building,
        floor,
        area,
        locationType,
        squareFootage,
        locationAliases,
      } = req.body;

      if (!code || !name) {
        return res.status(400).json({ error: "Code and name are required." });
      }

      const maxSort = await prisma.stockLocation.aggregate({
        where: { storeLocationId },
        _max: { sortOrder: true },
      });
      const nextSort = (maxSort._max.sortOrder ?? 0) + 1;

      const stockLocation = await prisma.stockLocation.create({
        data: {
          storeLocationId,
          code,
          name,
          description: description || null,
          building: building || null,
          floor: floor != null ? Number.parseInt(floor) : null,
          area: area != null ? Number.parseInt(area) : null,
          locationType: locationType || "STOCK",
          squareFootage: squareFootage != null ? Number.parseInt(squareFootage) : null,
          locationAliases: Array.isArray(locationAliases) ? locationAliases : [],
          sortOrder: nextSort,
          createdBy: session.user?.email || null,
        },
      });

      return res.status(201).json(stockLocation);
    } catch (error: unknown) {
      if (getErrorCode(error) === "P2002") {
        return res
          .status(409)
          .json({ error: "A stock location with that code already exists at this location." });
      }
      logError("Error creating stock location", error);
      return res.status(500).json({ error: "Failed to create stock location" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
