// /app/src/pages/api/dispatch/pick-lists/[id]/items.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const pickListId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(pickListId)) return res.status(400).json({ error: "Invalid pick list ID" });

  const { itemId, picked } = req.body;

  if (!itemId || typeof picked !== "boolean") {
    return res.status(400).json({ error: "itemId and picked (boolean) are required" });
  }

  try {
    // Verify the item belongs to this pick list
    const item = await prisma.pickListItem.findFirst({
      where: { id: Number.parseInt(itemId), pickListId },
    });

    if (!item) {
      return res.status(404).json({ error: "Pick list item not found" });
    }

    const updatedItem = await prisma.pickListItem.update({
      where: { id: item.id },
      data: {
        picked,
        pickedAt: picked ? new Date() : null,
        pickedByUserId: picked ? session.user?.email || null : null,
      },
    });

    // Check if all items are now picked and auto-complete the pick list
    if (picked) {
      const unpickedCount = await prisma.pickListItem.count({
        where: { pickListId, picked: false },
      });

      if (unpickedCount === 0) {
        await prisma.pickList.update({
          where: { id: pickListId },
          data: {
            status: "COMPLETED",
            updatedBy: session.user?.email || null,
          },
        });
      }
    } else {
      // If un-picking, ensure the pick list is not marked completed
      const pickList = await prisma.pickList.findUnique({
        where: { id: pickListId },
        select: { status: true },
      });

      if (pickList?.status === "COMPLETED") {
        await prisma.pickList.update({
          where: { id: pickListId },
          data: {
            status: "IN_PROGRESS",
            updatedBy: session.user?.email || null,
          },
        });
      }
    }

    return res.status(200).json(updatedItem);
  } catch (error) {
    logError("Error updating pick list item", error);
    return res.status(500).json({ error: "Failed to update pick list item" });
  }
}
