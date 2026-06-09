// /app/src/pages/api/consignment/po-management/apply-credits.ts
//
// Apply creditOwed items to an existing payment batch. Subtracts the credit
// amounts from the batch total and clears creditOwed on the items.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { creditItemIds, batchId } = req.body;

  if (!Array.isArray(creditItemIds) || creditItemIds.length === 0) {
    return res.status(400).json({ error: "creditItemIds must be a non-empty array" });
  }
  if (!batchId) {
    return res.status(400).json({ error: "batchId is required" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.consignmentPaymentBatch.findUnique({
        where: { id: batchId },
        select: { id: true, totalAmount: true },
      });
      if (!batch) throw new Error("Payment batch not found");

      const creditItems = await tx.consignmentItem.findMany({
        where: { id: { in: creditItemIds } },
        select: { id: true, cost: true, creditOwed: true },
      });

      if (creditItems.length !== creditItemIds.length) {
        throw new Error("Some credit items were not found");
      }

      const notCredit = creditItems.filter((i) => !i.creditOwed);
      if (notCredit.length > 0) {
        throw new Error(`${notCredit.length} items do not have credit owed`);
      }

      const creditTotal = creditItems.reduce((sum: number, i) => sum + Number(i.cost), 0);
      const newTotal = Number(batch.totalAmount) - creditTotal;

      await tx.consignmentPaymentBatch.update({
        where: { id: batchId },
        data: {
          totalAmount: newTotal,
          itemCount: { increment: creditItems.length },
          updatedBy: session.user?.email ?? null,
        },
      });

      await tx.consignmentItem.updateMany({
        where: { id: { in: creditItemIds } },
        data: {
          creditOwed: false,
          creditBatchId: batchId,
          updatedBy: session.user?.email ?? null,
        },
      });

      return { batchId, creditCount: creditItems.length, creditTotal, newBatchTotal: newTotal };
    }, TX_TIMEOUT.SHORT);

    logger.info("Applied credits to existing batch", {
      batchId: result.batchId,
      creditCount: result.creditCount,
      creditTotal: result.creditTotal,
    });

    return res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message.includes("not found") || err.message.includes("credit owed")) {
        return res.status(400).json({ error: err.message });
      }
    }
    logError("Failed to apply credits to batch", err);
    return res.status(500).json({ error: "Failed to apply credits" });
  }
});
