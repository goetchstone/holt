// /app/src/pages/api/gift-cards/[id]/adjust.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { computeAdjustment } from "@/lib/giftCard";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid gift card ID" });

  const { newBalance, reason } = req.body;

  if (newBalance === undefined || newBalance === null || newBalance < 0) {
    return res.status(400).json({ error: "New balance must be zero or greater" });
  }

  if (!reason || typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ error: "Adjustment reason is required" });
  }

  const createdBy = session.user?.email || null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const card = await tx.giftCard.findUnique({ where: { id } });
      if (!card) throw new Error("NOT_FOUND");

      const currentBalance = Number(card.currentBalance);
      const { delta, newStatus } = computeAdjustment(currentBalance, newBalance);
      const adjustedBalance = Math.round(newBalance * 100) / 100;

      const updated = await tx.giftCard.update({
        where: { id },
        data: {
          currentBalance: adjustedBalance,
          status: newStatus,
          updatedBy: createdBy,
        },
      });

      const transaction = await tx.giftCardTransaction.create({
        data: {
          giftCardId: id,
          transactionType: "ADJUSTMENT",
          amount: delta,
          balanceBefore: currentBalance,
          balanceAfter: adjustedBalance,
          reference: reason.trim(),
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
    if (getErrorMessage(err, "") === "NOT_FOUND") {
      return res.status(404).json({ error: "Gift card not found" });
    }
    logError("POST /gift-cards/[id]/adjust error", err);
    return res.status(500).json({ error: "Failed to adjust gift card balance" });
  }
});
