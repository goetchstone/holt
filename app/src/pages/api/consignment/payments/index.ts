// /app/src/pages/api/consignment/payments/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 50;
      const skip = (page - 1) * limit;

      const [batches, total] = await Promise.all([
        prisma.consignmentPaymentBatch.findMany({
          skip,
          take: limit,
          orderBy: { batchDate: "desc" },
          include: {
            vendor: { select: { id: true, name: true } },
            purchaseOrder: { select: { id: true, poNumber: true } },
            _count: { select: { items: true } },
          },
        }),
        prisma.consignmentPaymentBatch.count(),
      ]);

      const safeBatches = batches.map((b) => ({
        ...b,
        totalAmount: Number(b.totalAmount),
        itemCount: b._count.items,
        poNumber: b.purchaseOrder?.poNumber ?? null,
        purchaseOrderId: b.purchaseOrder?.id ?? null,
        _count: undefined,
        purchaseOrder: undefined,
      }));

      return res.json({ batches: safeBatches, total, page, limit });
    } catch (error) {
      logError("Error listing payment batches", error);
      return res.status(500).json({ error: "Failed to list payment batches" });
    }
  }

  if (req.method === "POST") {
    const { vendorId, periodStart, periodEnd, checkNumber } = req.body;

    if (!vendorId || !periodStart || !periodEnd) {
      return res.status(400).json({ error: "vendorId, periodStart, and periodEnd are required" });
    }

    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid date format for periodStart or periodEnd" });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const eligibleItems = await tx.consignmentItem.findMany({
          where: {
            vendorId,
            status: "SOLD",
            consignmentPaymentBatchId: null,
            saleDate: { gte: start, lte: end },
          },
        });

        if (eligibleItems.length === 0) {
          throw new Error("NO_ELIGIBLE_ITEMS");
        }

        const totalAmount = eligibleItems.reduce((sum, item) => sum + Number(item.cost), 0);

        const batch = await tx.consignmentPaymentBatch.create({
          data: {
            vendorId,
            periodStart: start,
            periodEnd: end,
            checkNumber: checkNumber || null,
            totalAmount,
            itemCount: eligibleItems.length,
            createdBy: session.user?.email ?? null,
          },
        });

        await tx.consignmentItem.updateMany({
          where: { id: { in: eligibleItems.map((i) => i.id) } },
          data: {
            consignmentPaymentBatchId: batch.id,
            status: "PAID",
            paidDate: new Date(),
            updatedBy: session.user?.email ?? null,
          },
        });

        return batch;
      });

      return res.status(201).json({
        ...result,
        totalAmount: Number(result.totalAmount),
      });
    } catch (error: unknown) {
      if (getErrorMessage(error, "") === "NO_ELIGIBLE_ITEMS") {
        return res
          .status(400)
          .json({ error: "No sold items found for this vendor in the given period" });
      }
      logError("Error creating payment batch", error);
      return res.status(500).json({ error: "Failed to create payment batch" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
