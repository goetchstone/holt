// /app/src/pages/api/inventory/physical-count.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const userId = (session.user as any)?.id;

  const { productId, stockLocation, quantity } = req.body;

  if (!productId || !stockLocation || quantity == null) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const newCount = await prisma.physicalInventoryCount.create({
      data: {
        productId: Number(productId),
        stockLocation,
        quantity: Number(quantity),
        userId: userId, // ** FIX: Associate the scan with the logged-in user **
      },
    });
    res.status(201).json(newCount);
  } catch (error) {
    logError("Failed to save physical count", error);
    res.status(500).json({ error: "Failed to save physical count." });
  }
}

export default requirePermission("inventory.count", handler);
