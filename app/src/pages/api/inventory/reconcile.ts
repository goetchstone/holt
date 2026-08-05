// /app/src/pages/api/inventory/reconcile.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const userId = (session.user as any)?.id;

  const { item, action, correctedCount } = req.body;

  if (!item || !action) {
    return res.status(400).json({ error: "Missing item or action." });
  }

  try {
    // Prefer productId (holt's own identity, always present on rows from the
    // current variance-report/accurate-scans APIs). Fall back to externalId
    // lookup for older cached frontend bundles -- but a native-born product
    // (no externalId) can only ever arrive with a productId, since it has no
    // externalId to send.
    const product = item.productId
      ? await prisma.product.findUnique({ where: { id: Number(item.productId) } })
      : await prisma.product.findUnique({ where: { externalId: item.externalId } });
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

export default requireAuthWithRole(["MANAGER", "ADMIN", "WAREHOUSE"], handler);
