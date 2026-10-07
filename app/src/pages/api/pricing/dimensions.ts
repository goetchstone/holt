// /app/src/pages/api/pricing/dimensions.ts
//
// GET /api/pricing/dimensions?vendorId=X — list price dimensions and tiers for a vendor

import { requirePermission } from "@/lib/auth/requireAuth";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const vendorId = Number.parseInt(req.query.vendorId as string);
  if (Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "vendorId is required" });
  }

  try {
    const dimensions = await prisma.vendorPriceDimension.findMany({
      where: { vendorId },
      include: {
        tiers: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            code: true,
            name: true,
            sortOrder: true,
            unitPrice: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return res.json(dimensions);
  } catch (error: unknown) {
    logError("Dimensions query error", error);
    return res.status(500).json({ error: "Failed to fetch dimensions" });
  }
}

export default requirePermission("catalog.pricing", handler);
