// /app/src/pages/api/inventory/reconcile-unidentified.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { scanId, productId, action } = req.body;

  if (!scanId || !action) {
    return res.status(400).json({ error: "scanId and action are required." });
  }

  try {
    const scan = await prisma.unidentifiedScan.findUnique({ where: { id: scanId } });
    if (!scan) {
      return res.status(404).json({ error: "Scan not found." });
    }

    if (action === "IGNORE") {
      const updatedScan = await prisma.unidentifiedScan.update({
        where: { id: scanId },
        data: {
          reconciliationStatus: "IGNORED",
          reconciledAt: new Date(),
        },
      });
      return res.status(200).json(updatedScan);
    }

    if (action === "RECONCILE") {
      if (!productId) {
        return res.status(400).json({ error: "productId is required for reconciliation." });
      }

      // Use a transaction to ensure both operations succeed or fail together
      const [_updatedScan, newCount] = await prisma.$transaction([
        // 1. Update the unidentified scan record
        prisma.unidentifiedScan.update({
          where: { id: scanId },
          data: {
            reconciliationStatus: "RECONCILED",
            reconciledAt: new Date(),
            reconciledProductId: productId,
          },
        }),
        // 2. Create a new entry in the main physical count table
        prisma.physicalInventoryCount.create({
          data: {
            productId: productId,
            stockLocation: scan.location,
            quantity: 1, // Each photo represents a quantity of 1
            userId: scan.countedByUserId,
          },
        }),
      ]);

      return res.status(200).json({ success: true, countId: newCount.id });
    }

    return res.status(400).json({ error: "Invalid action." });
  } catch (error) {
    logError("Failed to reconcile scan", error);
    res.status(500).json({ error: "Failed to reconcile scan." });
  }
}
