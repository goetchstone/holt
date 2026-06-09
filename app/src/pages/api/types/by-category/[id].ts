// /app/src/pages/api/types/by-category/[id].ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const categoryIdRaw = req.query.id;

  const categoryId = Number.parseInt(categoryIdRaw as string);
  if (Number.isNaN(categoryId)) {
    return res.status(400).json({ error: "Invalid category ID" });
  }

  try {
    const types = await prisma.type.findMany({
      where: { categoryId },
      orderBy: { name: "asc" },
    });
    res.status(200).json(types);
  } catch (err) {
    logError("[types/by-category] Error", err);
    res.status(500).json({ error: "Failed to load types for category" });
  }
}
