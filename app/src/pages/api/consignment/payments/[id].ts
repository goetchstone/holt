// /app/src/pages/api/consignment/payments/[id].ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    const batch = await prisma.consignmentPaymentBatch.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, name: true } },
        items: {
          select: {
            id: true,
            barcode: true,
            quality: true,
            size: true,
            cost: true,
            saleDate: true,
            saleCustomerName: true,
          },
        },
      },
    });

    if (!batch) return res.status(404).json({ error: "Payment batch not found" });

    return res.json({
      ...batch,
      totalAmount: Number(batch.totalAmount),
      items: batch.items.map((item) => ({
        ...item,
        cost: Number(item.cost),
      })),
    });
  }

  if (req.method === "PUT") {
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
        include: {
          vendor: { select: { id: true, name: true } },
        },
      });

      return res.json({
        ...updated,
        totalAmount: Number(updated.totalAmount),
      });
    } catch (error) {
      logError("Error updating payment batch", error);
      return res.status(500).json({ error: "Failed to update payment batch" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
