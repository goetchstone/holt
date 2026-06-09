// /app/src/pages/api/gift-cards/[id]/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

function toNum(d: any): number {
  if (d === null || d === undefined) return 0;
  return typeof d === "number" ? d : Number(d);
}

export default requireAuth(async (req, res, session) => {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid gift card ID" });

  if (req.method === "GET") {
    try {
      const card = await prisma.giftCard.findUnique({
        where: { id },
        include: {
          transactions: {
            orderBy: { created: "desc" },
          },
        },
      });

      if (!card) {
        return res.status(404).json({ error: "Gift card not found" });
      }

      return res.status(200).json({
        ...card,
        initialAmount: toNum(card.initialAmount),
        currentBalance: toNum(card.currentBalance),
        transactions: card.transactions.map((t) => ({
          ...t,
          amount: toNum(t.amount),
          balanceBefore: toNum(t.balanceBefore),
          balanceAfter: toNum(t.balanceAfter),
        })),
      });
    } catch (err) {
      logError("GET /gift-cards/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { notes } = req.body;

    try {
      const card = await prisma.giftCard.update({
        where: { id },
        data: {
          ...(notes !== undefined && { notes }),
          updatedBy: session.user?.email || null,
        },
      });
      return res.status(200).json({
        ...card,
        initialAmount: toNum(card.initialAmount),
        currentBalance: toNum(card.currentBalance),
      });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Gift card not found" });
      }
      logError("PUT /gift-cards/[id] error", err);
      return res.status(500).json({ error: "Failed to update gift card" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
});
