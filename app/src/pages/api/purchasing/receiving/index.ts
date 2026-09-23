// /app/src/pages/api/purchasing/receiving/index.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string)?.trim() || "";

    const skip = (page - 1) * limit;

    const where: Prisma.ReceivingRecordWhereInput = search
      ? {
          OR: [
            { externalPorNo: { contains: search, mode: "insensitive" } },
            { invoiceNumber: { contains: search, mode: "insensitive" } },
            {
              purchaseOrder: {
                poNumber: { contains: search, mode: "insensitive" },
              },
            },
            {
              purchaseOrder: {
                vendor: { name: { contains: search, mode: "insensitive" } },
              },
            },
          ],
        }
      : {};

    const [records, total] = await Promise.all([
      prisma.receivingRecord.findMany({
        where,
        skip,
        take: limit,
        orderBy: { receivedDate: "desc" },
        include: {
          purchaseOrder: {
            select: {
              poNumber: true,
              vendor: { select: { name: true } },
            },
          },
          purchaseOrderItem: {
            select: { partNo: true, productName: true },
          },
        },
      }),
      prisma.receivingRecord.count({ where }),
    ]);

    const safeRecords = records.map((r) => ({
      id: r.id,
      externalPorNo: r.externalPorNo,
      poNumber: r.purchaseOrder.poNumber,
      vendorName: r.purchaseOrder.vendor.name,
      partNo: r.purchaseOrderItem.partNo,
      productName: r.purchaseOrderItem.productName,
      quantityReceived: Number(r.quantityReceived),
      receivedDate: r.receivedDate,
      destinationLocation: r.destinationLocation,
      invoiceNumber: r.invoiceNumber,
      lineCost: r.lineCost != null ? Number(r.lineCost) : null,
      purchaseOrderId: r.purchaseOrderId,
    }));

    return res.status(200).json({ records: safeRecords, total });
  } catch (error) {
    logError("Error fetching receiving records", error);
    return res.status(500).json({ error: "Failed to fetch receiving records" });
  }
}

export default requirePermission("purchasing.receive", handler);
