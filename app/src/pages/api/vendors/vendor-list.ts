// /app/src/pages/api/vendors/vendor-list.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const vendors = await prisma.vendor.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    return res.status(200).json(vendors);
  } catch (error) {
    logError("Error fetching vendor list", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default requirePermission("catalog.write", handler);
