// /app/src/pages/api/consignment/items/return-from-approval.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { itemIds } = req.body;

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

    const invalid = items.filter((i) => i.status !== "ON_APPROVAL");
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Items must be ON_APPROVAL to return from approval`,
        invalidItems: invalid.map((i) => ({ id: i.id, barcode: i.barcode, status: i.status })),
      });
    }

    const result = await prisma.$transaction(
      itemIds.map((itemId: number) =>
        prisma.consignmentItem.update({
          where: { id: itemId },
          data: {
            status: "ON_FLOOR",
            onApprovalDate: null,
            onApprovalCustomer: null,
            onApprovalNotes: null,
            updatedBy: session.user?.email ?? null,
          },
        }),
      ),
    );

    return res.json({ updated: result.length });
  } catch (error) {
    logError("Error returning consignment items from approval", error);
    return res.status(500).json({ error: "Failed to return items from approval" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN", "WAREHOUSE"], handler);
