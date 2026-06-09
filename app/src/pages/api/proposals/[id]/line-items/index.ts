// /app/src/pages/api/proposals/[id]/line-items/index.ts
//
// POST: Add a line item to a proposal.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
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

    try {
      const {
        type,
        productId,
        vendorStyleId,
        itemName,
        itemDescription,
        vendorName,
        partNumber,
        cost,
        retailPrice,
        quantity,
        selectedGrade,
        selectedFinish,
        selectedOptions,
        itemNotes,
      } = req.body;

      if (!itemName) return res.status(400).json({ error: "itemName is required" });
      if (cost === undefined || retailPrice === undefined) {
        return res.status(400).json({ error: "cost and retailPrice are required" });
      }

      const lastItem = await prisma.proposalLineItem.findFirst({
        where: { proposalId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      const nextSort = (lastItem?.sortOrder ?? -1) + 1;

      const lineItem = await prisma.proposalLineItem.create({
        data: {
          proposalId,
          sortOrder: nextSort,
          type: type || "CUSTOM",
          productId: productId ? Number(productId) : undefined,
          vendorStyleId: vendorStyleId ? Number(vendorStyleId) : undefined,
          itemName,
          itemDescription: itemDescription || null,
          vendorName: vendorName || null,
          partNumber: partNumber || null,
          cost: Number(cost),
          retailPrice: Number(retailPrice),
          quantity: Number(quantity) || 1,
          selectedGrade: selectedGrade || null,
          selectedFinish: selectedFinish || null,
          selectedOptions: selectedOptions || null,
          itemNotes: itemNotes || null,
        },
        include: { images: true },
      });

      return res.status(201).json(lineItem);
    } catch (err: unknown) {
      logError("Failed to add proposal line item", err);
      return res.status(500).json({ error: "Failed to add line item" });
    }
  },
);
