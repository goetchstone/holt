// /app/src/pages/api/proposals/[id]/line-items/[lineId]/index.ts
//
// PUT: Update a line item (price, notes, quantity, etc.)
// DELETE: Remove a line item.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    const lineId = Number.parseInt(req.query.lineId as string, 10);
    if (Number.isNaN(lineId)) return res.status(400).json({ error: "Invalid line item ID" });

    if (req.method === "PUT") return handlePut(lineId, req, res);
    if (req.method === "DELETE") return handleDelete(lineId, res);
    res.setHeader("Allow", ["PUT", "DELETE"]);
    return res.status(405).end();
  },
);

async function handlePut(lineId: number, req: NextApiRequest, res: NextApiResponse) {
  try {
    const {
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
      showInOutput,
    } = req.body;

    const data: Record<string, unknown> = {};
    if (itemName !== undefined) data.itemName = itemName;
    if (itemDescription !== undefined) data.itemDescription = itemDescription;
    if (vendorName !== undefined) data.vendorName = vendorName;
    if (partNumber !== undefined) data.partNumber = partNumber;
    if (cost !== undefined) data.cost = Number(cost);
    if (retailPrice !== undefined) data.retailPrice = Number(retailPrice);
    if (quantity !== undefined) data.quantity = Number(quantity);
    if (selectedGrade !== undefined) data.selectedGrade = selectedGrade;
    if (selectedFinish !== undefined) data.selectedFinish = selectedFinish;
    if (selectedOptions !== undefined) data.selectedOptions = selectedOptions;
    if (itemNotes !== undefined) data.itemNotes = itemNotes;
    if (showInOutput !== undefined) data.showInOutput = showInOutput;

    const lineItem = await prisma.proposalLineItem.update({
      where: { id: lineId },
      data,
      include: { images: true },
    });

    return res.status(200).json(lineItem);
  } catch (err: unknown) {
    logError("Failed to update proposal line item", err);
    return res.status(500).json({ error: "Failed to update line item" });
  }
}

async function handleDelete(lineId: number, res: NextApiResponse) {
  try {
    await prisma.proposalLineItem.delete({ where: { id: lineId } });
    return res.status(200).json({ deleted: true });
  } catch (err: unknown) {
    logError("Failed to delete proposal line item", err);
    return res.status(500).json({ error: "Failed to delete line item" });
  }
}
