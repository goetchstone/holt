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
    const locations = await prisma.inventorySnapshot.findMany({
      select: {
        stockLocation: true,
      },
      distinct: ["stockLocation"],
      orderBy: {
        stockLocation: "asc",
      },
    });

    const locationNames = locations.map((l) => l.stockLocation);
    res.status(200).json(locationNames);
  } catch (error) {
    logError("Error fetching inventory locations", error);
    res.status(500).json({ error: "Failed to fetch inventory locations." });
  }
}
