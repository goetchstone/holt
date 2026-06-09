// /app/src/pages/api/pricing/dimensions.ts
//
// GET /api/pricing/dimensions?vendorId=X — list price dimensions and tiers for a vendor

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
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
    return res.status(500).json({
      error: "Failed to fetch dimensions",
      details: getErrorMessage(error, "Internal server error"),
    });
  }
}
