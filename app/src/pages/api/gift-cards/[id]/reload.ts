// /app/src/pages/api/gift-cards/[id]/reload.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth/requireAuth";
import { computeReload } from "@/lib/giftCard";
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

      if (card.status === "VOIDED") {
        throw new Error("Cannot reload a voided card");
      }

      const currentBalance = Number(card.currentBalance);
      const { newBalance } = computeReload(currentBalance, amount);

      const updated = await tx.giftCard.update({
        where: { id },
        data: {
          currentBalance: newBalance,
          status: "ACTIVE",
          updatedBy: createdBy,
        },
      });

      const transaction = await tx.giftCardTransaction.create({
        data: {
          giftCardId: id,
          transactionType: "RELOAD",
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
    const message = getErrorMessage(err, "Failed to reload gift card");
    if (message === "NOT_FOUND") {
      return res.status(404).json({ error: "Gift card not found" });
    }
    if (message.startsWith("Cannot reload")) {
      return res.status(400).json({ error: message });
    }
    logError("POST /gift-cards/[id]/reload error", err);
    return res.status(500).json({ error: "Failed to reload gift card" });
  }
});
