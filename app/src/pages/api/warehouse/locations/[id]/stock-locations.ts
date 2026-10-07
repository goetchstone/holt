// /app/src/pages/api/warehouse/locations/[id]/stock-locations.ts
//
// CRUD for StockLocations within a StoreLocation, on "Set up stores and stock
// locations" (inventory.locations.manage, SEC-15). Pickers read
// /api/store-locations/stock-locations instead.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
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
        holdsCommittedStock,
      } = req.body;

      if (!code || !name) {
        return res.status(400).json({ error: "Code and name are required." });
      }

      // Validated rather than coerced: this flag decides whether stock here
      // is sellable, and a truthy string ("false") quietly reclassifying a
      // whole location is not a failure mode worth having.
      if (holdsCommittedStock !== undefined && typeof holdsCommittedStock !== "boolean") {
        return res.status(400).json({ error: "holdsCommittedStock must be a boolean." });
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
          holdsCommittedStock: holdsCommittedStock === true,
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

// GET keeps its audience (Transfer stock, as before); POST is setup.
const readGate = requirePermission(
  { anyOf: ["inventory.locations.manage", "inventory.transfer"] },
  handler,
);
const writeGate = requirePermission("inventory.locations.manage", handler);

export default async function route(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return readGate(req, res);
  return writeGate(req, res);
}
