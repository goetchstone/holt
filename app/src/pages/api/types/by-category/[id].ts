// /app/src/pages/api/types/by-category/[id].ts

import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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

export default requirePermission("catalog.write", handler);
