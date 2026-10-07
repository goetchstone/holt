// /app/src/pages/api/consignment/unpaid-sales.ts
//
// Returns all SOLD consignment items with no payment batch, oldest first.
// Used to identify and research items that should have been paid already.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { rowsWithCostFor, WITH_COST } from "@/lib/auth/costVisibility";
import { prisma } from "@/lib/prisma";

export interface UnpaidSaleItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  /** Present only for a viewer holding "View cost" (the response says which). */
  cost?: number;
  saleDate: string | null;
  saleCustomerName: string | null;
  salesOrderId: number | null;
  orderNumber: string | null;
  vendor: { name: string };
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
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

    // What is owed to the consignor for each rug only for a holder of "View cost".
    const { rows, costVisible } = rowsWithCostFor(access, result, ["cost"]);
    return res.json({ items: rows, total: result.length, costVisible });
  } catch {
    return res.status(500).json({ error: "Failed to load unpaid sales" });
  }
}

export default requirePermission("purchasing.write", handler, WITH_COST);
