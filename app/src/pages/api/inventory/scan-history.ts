// /app/src/pages/api/inventory/scan-history.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as any)?.id;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated." });
  }

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
