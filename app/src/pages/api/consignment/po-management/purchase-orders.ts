// /app/src/pages/api/consignment/po-management/purchase-orders.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const status = req.query.status as string | undefined;

  const where: any = {
    vendor: { name: { contains: "marjan", mode: "insensitive" as const } },
  };
  if (status) {
    where.status = status;
  }

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where,
    orderBy: { orderDate: "desc" },
    select: {
      id: true,
      poNumber: true,
      orderDate: true,
      status: true,
      vendor: { select: { id: true, name: true } },
      consignmentPaymentBatch: { select: { id: true } },
      _count: { select: { lineItems: true } },
    },
    take: 100,
  });

  const result = purchaseOrders.map((po) => ({
    id: po.id,
    poNumber: po.poNumber,
    orderDate: po.orderDate,
    status: po.status,
    vendorId: po.vendor.id,
    vendorName: po.vendor.name,
    lineItemCount: po._count.lineItems,
    hasBatch: po.consignmentPaymentBatch !== null,
    batchId: po.consignmentPaymentBatch?.id ?? null,
  }));

  return res.json(result);
});
