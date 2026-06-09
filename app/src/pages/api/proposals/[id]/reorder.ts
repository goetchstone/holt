// /app/src/pages/api/proposals/[id]/reorder.ts
//
// POST: Bulk update sortOrder for drag-and-drop reorder.
// Body: { lineItemIds: number[] } — ordered list of line item IDs.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end();
    }

    const proposalId = Number.parseInt(req.query.id as string, 10);
    if (Number.isNaN(proposalId)) return res.status(400).json({ error: "Invalid proposal ID" });

    const { lineItemIds } = req.body;
    if (!Array.isArray(lineItemIds)) {
      return res.status(400).json({ error: "lineItemIds array is required" });
    }

    try {
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < lineItemIds.length; i++) {
          await tx.proposalLineItem.update({
            where: { id: lineItemIds[i] },
            data: { sortOrder: i },
          });
        }
      }, TX_TIMEOUT.SHORT);

      return res.status(200).json({ reordered: true });
    } catch (err: unknown) {
      logError("Failed to reorder proposal line items", err);
      return res.status(500).json({ error: "Failed to reorder line items" });
    }
  },
);
