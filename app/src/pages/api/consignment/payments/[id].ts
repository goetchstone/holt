// /app/src/pages/api/consignment/payments/[id].ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function getBatch(res: NextApiResponse, id: number, showCost: boolean) {
  const batch = await prisma.consignmentPaymentBatch.findUnique({
    where: { id },
    omit: { totalAmount: !showCost },
    include: {
      vendor: { select: { id: true, name: true } },
      items: {
        select: {
          id: true,
          barcode: true,
          quality: true,
          size: true,
          cost: showCost,
          saleDate: true,
          saleCustomerName: true,
        },
      },
    },
  });

  if (!batch) return res.status(404).json({ error: "Payment batch not found" });

  return res.json({
    ...batch,
    ...(showCost ? { totalAmount: Number(batch.totalAmount) } : {}),
    items: batch.items.map((item) => ({
      ...item,
      ...(showCost ? { cost: Number(item.cost) } : {}),
    })),
    costVisible: showCost,
  });
}

async function updateBatch(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  id: number,
  showCost: boolean,
) {
  const existing = await prisma.consignmentPaymentBatch.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Payment batch not found" });

  const data: any = { updatedBy: session.user?.email ?? null };

  if (req.body.checkNumber !== undefined) data.checkNumber = req.body.checkNumber;
  if (req.body.isPaid !== undefined) data.isPaid = req.body.isPaid;
  if (req.body.notes !== undefined) data.notes = req.body.notes;

  try {
    const updated = await prisma.consignmentPaymentBatch.update({
      where: { id },
      data,
      omit: { totalAmount: !showCost },
      include: {
        vendor: { select: { id: true, name: true } },
      },
    });

    return res.json({
      ...updated,
      ...(showCost ? { totalAmount: Number(updated.totalAmount) } : {}),
      costVisible: showCost,
    });
  } catch (error) {
    logError("Error updating payment batch", error);
    return res.status(500).json({ error: "Failed to update payment batch" });
  }
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  // What was paid, or is owed, to the consignor only for a holder of "View cost".
  const showCost = canViewCost(access);
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") return getBatch(res, id, showCost);
  if (req.method === "PUT") return updateBatch(req, res, session, id, showCost);
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("purchasing.write", handler, WITH_COST);
