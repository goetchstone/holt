// /app/src/pages/api/consignment/unpaid-sales.ts
//
// Returns all SOLD consignment items with no payment batch, oldest first.
// Used to identify and research items that should have been paid already.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

export interface UnpaidSaleItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  cost: number;
  saleDate: string | null;
  saleCustomerName: string | null;
  salesOrderId: number | null;
  orderNumber: string | null;
  vendor: { name: string };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const items = await prisma.consignmentItem.findMany({
      where: {
        status: "SOLD",
        consignmentPaymentBatchId: null,
      },
      orderBy: { saleDate: "asc" },
      include: {
        vendor: { select: { name: true } },
        salesOrder: {
          select: {
            orderno: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    const result: UnpaidSaleItem[] = items.map((i) => {
      const custFirst = i.salesOrder?.customer?.firstName ?? "";
      const custLast = i.salesOrder?.customer?.lastName ?? "";
      const customerName = `${custFirst} ${custLast}`.trim() || i.saleCustomerName || null;
      return {
        id: i.id,
        barcode: i.barcode,
        customerNumber: i.customerNumber,
        quality: i.quality,
        size: i.size,
        cost: Number(i.cost),
        saleDate: i.saleDate?.toISOString() ?? null,
        saleCustomerName: customerName,
        salesOrderId: i.salesOrderId,
        orderNumber: i.salesOrder?.orderno ?? null,
        vendor: i.vendor ? { name: i.vendor.name } : { name: "" },
      };
    });

    return res.json({ items: result, total: result.length });
  } catch {
    return res.status(500).json({ error: "Failed to load unpaid sales" });
  }
}
