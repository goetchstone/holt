// /app/src/pages/api/consignment/po-management/assign-to-batch.ts
//
// Creates a payment batch from selected SOLD items (positive lines) and
// optionally applies creditOwed items (negative lines). The net total
// is what gets written on the check to Marjan.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { consignmentItemIds, creditItemIds, checkNumber, notes } = req.body;

  const soldIds: number[] = Array.isArray(consignmentItemIds) ? consignmentItemIds : [];
  const credIds: number[] = Array.isArray(creditItemIds) ? creditItemIds : [];

  if (soldIds.length === 0 && credIds.length === 0) {
    return res.status(400).json({ error: "Select at least one sold item or credit item" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Validate sold items: must be SOLD with no existing batch
      let soldTotal = 0;
      if (soldIds.length > 0) {
        const soldItems = await tx.consignmentItem.findMany({
          where: { id: { in: soldIds } },
          select: {
            id: true,
            status: true,
            cost: true,
            vendorId: true,
            consignmentPaymentBatchId: true,
          },
        });

        if (soldItems.length !== soldIds.length) {
          throw new Error("Some sold items were not found");
        }

        const notSold = soldItems.filter((i) => i.status !== "SOLD");
        if (notSold.length > 0) {
          throw new Error(`${notSold.length} items are not in SOLD status`);
        }

        const alreadyAssigned = soldItems.filter((i) => i.consignmentPaymentBatchId !== null);
        if (alreadyAssigned.length > 0) {
          throw new Error(`${alreadyAssigned.length} items already assigned to a batch`);
        }

        soldTotal = soldItems.reduce((sum: number, i) => sum + Number(i.cost), 0);
      }

      // Validate credit items: must have creditOwed=true
      let creditTotal = 0;
      if (credIds.length > 0) {
        const creditItems = await tx.consignmentItem.findMany({
          where: { id: { in: credIds } },
          select: { id: true, cost: true, creditOwed: true, vendorId: true },
        });

        if (creditItems.length !== credIds.length) {
          throw new Error("Some credit items were not found");
        }

        const notCredit = creditItems.filter((i) => !i.creditOwed);
        if (notCredit.length > 0) {
          throw new Error(`${notCredit.length} items do not have credit owed`);
        }

        creditTotal = creditItems.reduce((sum: number, i) => sum + Number(i.cost), 0);
      }

      const netTotal = soldTotal - creditTotal;

      // Determine vendor from whichever items we have
      const allIds = [...soldIds, ...credIds];
      const anyItem = await tx.consignmentItem.findFirst({
        where: { id: { in: allIds } },
        select: { vendorId: true },
      });
      const vendorId = anyItem!.vendorId;

      const batch = await tx.consignmentPaymentBatch.create({
        data: {
          vendorId,
          batchDate: new Date(),
          periodStart: new Date(),
          periodEnd: new Date(),
          checkNumber: checkNumber || null,
          notes: notes || null,
          totalAmount: netTotal,
          itemCount: soldIds.length + credIds.length,
          createdBy: session.user?.email ?? null,
        },
      });

      // Mark sold items as PAID
      if (soldIds.length > 0) {
        await tx.consignmentItem.updateMany({
          where: { id: { in: soldIds } },
          data: {
            consignmentPaymentBatchId: batch.id,
            status: "PAID",
            paidDate: new Date(),
            updatedBy: session.user?.email ?? null,
          },
        });
      }

      // Clear creditOwed on credit items and link to this batch
      if (credIds.length > 0) {
        await tx.consignmentItem.updateMany({
          where: { id: { in: credIds } },
          data: {
            creditOwed: false,
            creditBatchId: batch.id,
            updatedBy: session.user?.email ?? null,
          },
        });
      }

      return {
        batchId: batch.id,
        soldCount: soldIds.length,
        creditCount: credIds.length,
        soldTotal,
        creditTotal,
        netTotal,
      };
    }, TX_TIMEOUT.SHORT);

    logger.info("Created consignment payment batch", {
      batchId: result.batchId,
      soldCount: result.soldCount,
      creditCount: result.creditCount,
      netTotal: result.netTotal,
    });

    return res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (
        err.message.includes("not found") ||
        err.message.includes("not in SOLD") ||
        err.message.includes("already assigned") ||
        err.message.includes("credit owed")
      ) {
        return res.status(400).json({ error: err.message });
      }
    }
    logError("Failed to create payment batch", err);
    return res.status(500).json({ error: "Failed to create payment batch" });
  }
});
