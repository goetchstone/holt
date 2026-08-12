// /app/src/pages/api/inventory/scan-history.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const userId = (session.user as any)?.id;

  const { location, cursor } = req.query;
  const limit = 25; // Fetch 25 scans at a time

  try {
    const counts = await prisma.physicalInventoryCount.findMany({
      where: {
        userId: userId,
        stockLocation: location as string,
      },
      take: limit,
      // This is the "infinite scroll" logic: skip the cursor if it exists
      skip: cursor ? 1 : 0,
      ...(cursor && { cursor: { id: Number(cursor) } }),
      orderBy: {
        countedAt: "desc",
      },
      include: {
        product: {
          select: { name: true, productNumber: true },
        },
      },
    });

    const nextCursor = counts.length === limit ? counts[limit - 1].id : null;

    res.status(200).json({ counts, nextCursor });
  } catch (error) {
    logError("Failed to fetch scan history", error);
    res.status(500).json({ error: "Failed to fetch scan history." });
  }
}

export default requirePermission("inventory.count", handler);
