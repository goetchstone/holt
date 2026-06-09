// /app/src/pages/api/gift-cards/[id]/redeem.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth/requireAuth";
import { computeRedemption } from "@/lib/giftCard";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default requireAuth(async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid gift card ID" });

  const { amount, reference } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than zero" });
  }

  const createdBy = session.user?.email || null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const card = await tx.giftCard.findUnique({ where: { id } });
      if (!card) throw new Error("NOT_FOUND");

      if (card.status !== "ACTIVE") {
        throw new Error(`Card is ${card.status} and cannot be redeemed`);
      }

      const currentBalance = Number(card.currentBalance);
      const { newBalance, newStatus } = computeRedemption(currentBalance, amount);

      const updated = await tx.giftCard.update({
        where: { id },
        data: {
          currentBalance: newBalance,
          status: newStatus,
          updatedBy: createdBy,
        },
      });

      const transaction = await tx.giftCardTransaction.create({
        data: {
          giftCardId: id,
          transactionType: "REDEMPTION",
          amount,
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          reference: reference || null,
          createdBy,
        },
      });

      return { card: updated, transaction };
    });

    return res.status(200).json({
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
  } catch (err: unknown) {
    const message = getErrorMessage(err, "Failed to redeem gift card");
    if (message === "NOT_FOUND") {
      return res.status(404).json({ error: "Gift card not found" });
    }
    if (message.startsWith("Card is") || message.startsWith("Redemption amount")) {
      return res.status(400).json({ error: message });
    }
    logError("POST /gift-cards/[id]/redeem error", err);
    return res.status(500).json({ error: "Failed to redeem gift card" });
  }
});
