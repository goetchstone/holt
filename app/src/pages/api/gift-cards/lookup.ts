// /app/src/pages/api/gift-cards/lookup.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

function toNum(d: any): number {
  if (d === null || d === undefined) return 0;
  return typeof d === "number" ? d : Number(d);
}

export default requireAuth(async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const barcode = ((req.query.barcode as string) || "").trim();
  const q = ((req.query.q as string) || "").trim();

  if (!barcode && !q) {
    return res.status(400).json({ error: "Provide barcode or q query parameter" });
  }

  try {
    if (barcode) {
      const card = await prisma.giftCard.findUnique({
        where: { barcode },
        include: {
          transactions: {
            orderBy: { created: "desc" },
            take: 20,
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
    }

    // Search by partial barcode or POS code
    const cards = await prisma.giftCard.findMany({
      where: {
        OR: [
          { barcode: { contains: q, mode: "insensitive" } },
          { externalCode: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { created: "desc" },
      take: 50,
    });

    return res.status(200).json(
      cards.map((c) => ({
        ...c,
        initialAmount: toNum(c.initialAmount),
        currentBalance: toNum(c.currentBalance),
      })),
    );
  } catch (err) {
    logError("GET /gift-cards/lookup error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});
