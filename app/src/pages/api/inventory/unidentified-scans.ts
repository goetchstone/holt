// /app/src/pages/api/inventory/unidentified-scans.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { location } = req.query;

  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "Location parameter is required." });
  }

  try {
    const scans = await prisma.unidentifiedScan.findMany({
      where: {
        location,
        reconciliationStatus: "PENDING",
      },
      include: {
        countedBy: {
          select: { name: true },
        },
      },
      orderBy: {
        countedAt: "desc",
      },
    });
    res.status(200).json(scans);
  } catch (error) {
    logError("Failed to fetch unidentified scans", error);
    res.status(500).json({ error: "Failed to fetch unidentified scans." });
  }
}
