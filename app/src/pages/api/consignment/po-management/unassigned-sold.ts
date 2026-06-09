// /app/src/pages/api/consignment/po-management/unassigned-sold.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const items = await prisma.consignmentItem.findMany({
    where: {
      status: "SOLD",
      consignmentPaymentBatchId: null,
    },
    include: {
      vendor: { select: { name: true } },
      salesOrder: {
        select: {
          orderno: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { saleDate: "asc" },
  });

  const result = items.map((item) => ({
    id: item.id,
    barcode: item.barcode,
    customerNumber: item.customerNumber,
    quality: item.quality,
    size: item.size,
    cost: Number(item.cost),
    saleDate: item.saleDate,
    vendorId: item.vendorId,
    vendorName: item.vendor?.name ?? null,
    orderNumber: item.salesOrder?.orderno ?? null,
    customerName: item.salesOrder?.customer
      ? `${item.salesOrder.customer.firstName ?? ""} ${item.salesOrder.customer.lastName ?? ""}`.trim()
      : null,
  }));

  return res.json({ items: result, total: result.length });
});
