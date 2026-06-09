// /app/src/pages/api/inventory/physical-count/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;

  if (req.method === "DELETE") {
    try {
      await prisma.physicalInventoryCount.delete({
        where: { id: Number(id) },
      });
      res.status(204).end(); // Success, no content to return
    } catch (error) {
      logError("Failed to delete scan", error);
      res.status(500).json({ error: "Failed to delete scan." });
    }
  } else {
    res.setHeader("Allow", ["DELETE"]);
    res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}
