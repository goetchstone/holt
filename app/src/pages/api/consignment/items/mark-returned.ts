// /app/src/pages/api/consignment/items/mark-returned.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { itemIds, returnReason } = req.body;

  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "itemIds must be a non-empty array" });
  }

  try {
    const items = await prisma.consignmentItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, status: true, barcode: true },
    });

    if (items.length !== itemIds.length) {
      const foundIds = items.map((i) => i.id);
      const missing = itemIds.filter((id: number) => !foundIds.includes(id));
      return res.status(404).json({ error: `Items not found: ${missing.join(", ")}` });
    }

    const invalid = items.filter((i) => i.status !== "ON_FLOOR" && i.status !== "MISSING");
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Items must be ON_FLOOR or MISSING to return to vendor`,
        invalidItems: invalid.map((i) => ({ id: i.id, barcode: i.barcode, status: i.status })),
      });
    }

    const result = await prisma.$transaction(
      itemIds.map((itemId: number) =>
        prisma.consignmentItem.update({
          where: { id: itemId },
          data: {
            status: "RETURNED_VENDOR",
            returnedDate: new Date(),
            returnReason: returnReason || null,
            updatedBy: session.user?.email ?? null,
          },
        }),
      ),
    );

    return res.json({ updated: result.length });
  } catch (error) {
    logError("Error marking consignment items as returned", error);
    return res.status(500).json({ error: "Failed to mark items as returned" });
  }
}
