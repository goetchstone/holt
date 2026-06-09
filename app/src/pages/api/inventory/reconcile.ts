// /app/src/pages/api/inventory/reconcile.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as any)?.id;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated." });
  }

  const { item, action, correctedCount } = req.body;

  if (!item || !action) {
    return res.status(400).json({ error: "Missing item or action." });
  }

  try {
    const product = await prisma.product.findUnique({ where: { externalId: item.externalId } });
    if (!product) {
      return res.status(404).json({ error: "Product not found to reconcile." });
    }

    let finalCount = item.counted;
    let finalVariance = item.variance;

    switch (action) {
      case "found": // Missing item was found
        finalCount = item.expected;
        finalVariance = 0;
        break;
      case "confirm": // Overage is confirmed to be correct
        // finalCount and finalVariance remain as they were
        break;
      case "correct": // Manual count correction
        if (typeof correctedCount !== "number") {
          return res.status(400).json({ error: "Corrected count must be a number." });
        }
        finalCount = correctedCount;
        finalVariance = correctedCount - item.expected;
        break;
      default:
        return res.status(400).json({ error: "Invalid action." });
    }

    const reconciliation = await prisma.reconciliation.upsert({
      where: {
        productId_location: {
          productId: product.id,
          location: item.location,
        },
      },
      update: {
        initialExpected: item.expected,
        initialCounted: item.counted,
        initialVariance: item.variance,
        actionTaken: action.toUpperCase(),
        finalCount: finalCount,
        finalVariance: finalVariance,
        reconciledAt: new Date(),
        reconciledByUserId: userId,
      },
      create: {
        productId: product.id,
        location: item.location,
        initialExpected: item.expected,
        initialCounted: item.counted,
        initialVariance: item.variance,
        actionTaken: action.toUpperCase(),
        finalCount: finalCount,
        finalVariance: finalVariance,
        reconciledByUserId: userId,
      },
    });

    res.status(200).json({ success: true, reconciliation });
  } catch (error) {
    logError("Reconciliation failed", error);
    res.status(500).json({ error: "Failed to save reconciliation." });
  }
}
