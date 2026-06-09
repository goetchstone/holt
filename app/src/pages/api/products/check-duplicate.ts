// /app/src/pages/api/products/check-duplicate.ts
//
// Checks whether a Product already exists for a given style number + vendor.
// Used by the configurator to warn salespeople before they re-enter an item
// that is already in the POS. Returns the matching product if found.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const styleNumber = req.query.styleNumber as string;
  const vendorId = Number.parseInt(req.query.vendorId as string);

  if (!styleNumber || Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "styleNumber and vendorId are required" });
  }

  try {
    // Check by vendorStyleId first (product created from this style template)
    const byStyle = await prisma.product.findFirst({
      where: {
        vendorStyle: { styleNumber, vendorId },
      },
      select: {
        id: true,
        productNumber: true,
        name: true,
        externalId: true,
      },
    });

    if (byStyle) {
      return res.status(200).json({ exists: true, product: byStyle });
    }

    // Fallback: check by productNumber matching the styleNumber
    const byNumber = await prisma.product.findFirst({
      where: {
        productNumber: styleNumber,
        vendorId,
      },
      select: {
        id: true,
        productNumber: true,
        name: true,
        externalId: true,
      },
    });

    if (byNumber) {
      return res.status(200).json({ exists: true, product: byNumber });
    }

    return res.status(200).json({ exists: false, product: null });
  } catch (error: unknown) {
    logError("Check duplicate error", error);
    return res.status(500).json({ error: "Failed to check duplicate" });
  }
}
