// /app/src/pages/api/inventory/physical-count.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ** FIX: Get the server-side session to identify the user **
  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as any)?.id;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }

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
