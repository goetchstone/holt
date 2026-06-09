// /app/src/pages/api/gift-cards/activate.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Activation happens at the till, so REGISTER staff need access too.
export default requireAuthWithRole(["REGISTER", "MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { barcode, amount } = req.body;

  if (!barcode || typeof barcode !== "string" || !barcode.trim()) {
    return res.status(400).json({ error: "Barcode is required" });
  }

  if (amount === undefined || amount === null || amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than zero" });
  }

  const trimmedBarcode = barcode.trim();
  const createdBy = session.user?.email || null;

  try {
    const existing = await prisma.giftCard.findUnique({
      where: { barcode: trimmedBarcode },
    });

    if (existing) {
      return res.status(409).json({
        error: `A gift card with barcode "${trimmedBarcode}" already exists (status: ${existing.status})`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const card = await tx.giftCard.create({
        data: {
          barcode: trimmedBarcode,
          initialAmount: amount,
          currentBalance: amount,
          status: "ACTIVE",
          activatedAt: new Date(),
          createdBy,
        },
      });

      const transaction = await tx.giftCardTransaction.create({
        data: {
          giftCardId: card.id,
          transactionType: "ISSUANCE",
          amount,
          balanceBefore: 0,
          balanceAfter: amount,
          createdBy,
        },
      });

      return { card, transaction };
    });

    return res.status(201).json({
      card: {
        ...result.card,
        initialAmount: Number(result.card.initialAmount),
        currentBalance: Number(result.card.currentBalance),
      },
      transaction: {
        ...result.transaction,
        amount: Number(result.transaction.amount),
        balanceBefore: Number(result.transaction.balanceBefore),
        balanceAfter: Number(result.transaction.balanceAfter),
      },
    });
  } catch (err) {
    logError("POST /gift-cards/activate error", err);
    return res.status(500).json({ error: "Failed to activate gift card" });
  }
});
