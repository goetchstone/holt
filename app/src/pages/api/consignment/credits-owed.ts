// /app/src/pages/api/consignment/credits-owed.ts
//
// Returns consignment items where creditOwed=true. These are rugs that were
// paid to the vendor but later returned by the customer. The business needs to apply
// a negative line on the next PO to recoup the cost.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

export interface CreditOwedItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  cost: number;
  status: string;
  paidDate: string | null;
  batchId: number | null;
  customerName: string | null;
  orderNumber: string | null;
  salesOrderId: number | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const items = await prisma.consignmentItem.findMany({
      where: { creditOwed: true },
      orderBy: { paidDate: "desc" },
      include: {
        vendor: { select: { name: true } },
        consignmentPaymentBatch: { select: { id: true, checkNumber: true } },
        salesOrder: {
          select: {
            orderno: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    const result: CreditOwedItem[] = items.map((i) => {
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
        status: i.status,
        paidDate: i.paidDate?.toISOString() ?? null,
        batchId: i.consignmentPaymentBatch?.id ?? null,
        customerName,
        orderNumber: i.salesOrder?.orderno ?? null,
        salesOrderId: i.salesOrderId,
      };
    });

    const totalCredit = result.reduce((sum, i) => sum + i.cost, 0);

    return res.json({ items: result, total: result.length, totalCredit });
  } catch {
    return res.status(500).json({ error: "Failed to load credits owed" });
  }
}
