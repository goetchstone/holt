// /app/src/pages/api/upboard/[store].ts
// GET /api/upboard/[store] — get the up-board for a store
// Auto-expires shifts older than 9 hours on every read.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { expireStaleShifts } from "@/lib/upboard";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const store = req.query.store as string;

  if (req.method === "GET") {
    // Clean up expired shifts before returning board state
    await expireStaleShifts();

    const entries = await prisma.upBoardEntry.findMany({
      where: { storeLocation: store },
      include: {
        staffMember: {
          select: { id: true, displayName: true, role: true },
        },
      },
      orderBy: { position: "asc" },
    });
    return res.json(entries);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
