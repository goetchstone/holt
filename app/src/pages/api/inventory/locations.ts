// /app/src/pages/api/inventory/locations.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    // InventorySnapshot's counting grain is storeLocationId (see its schema
    // comment), not a free-text location string, so the distinct-locations
    // list comes from resolving the ids present in the snapshot to their
    // StoreLocation names. Two queries rather than distinct+orderBy across a
    // relation, which Postgres' DISTINCT ON semantics don't support cleanly.
    const rows = await prisma.inventorySnapshot.findMany({
      select: { storeLocationId: true },
      distinct: ["storeLocationId"],
    });
    const storeLocations = await prisma.storeLocation.findMany({
      where: { id: { in: rows.map((r) => r.storeLocationId) } },
      select: { name: true },
      orderBy: { name: "asc" },
    });

    const locationNames = storeLocations.map((l) => l.name);
    res.status(200).json(locationNames);
  } catch (error) {
    logError("Error fetching inventory locations", error);
    res.status(500).json({ error: "Failed to fetch inventory locations." });
  }
}
