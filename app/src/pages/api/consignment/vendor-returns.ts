// /app/src/pages/api/consignment/vendor-returns.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const returns = await prisma.consignmentVendorReturn.findMany({
      orderBy: { returnDate: "desc" },
      include: {
        vendor: { select: { name: true } },
        items: {
          select: {
            id: true,
            barcode: true,
            customerNumber: true,
            quality: true,
            size: true,
            cost: true,
            creditOwed: true,
          },
        },
      },
    });

    const safeReturns = returns.map((r) => ({
      id: r.id,
      vendorName: r.vendor.name,
      returnDate: r.returnDate.toISOString(),
      confirmedDate: r.confirmedDate?.toISOString() ?? null,
      status: r.status,
      notes: r.notes,
      itemCount: r.items.length,
      totalCost: r.items.reduce((sum, i) => sum + Number(i.cost || 0), 0),
      creditCount: r.items.filter((i) => i.creditOwed).length,
      items: r.items.map((i) => ({
        id: i.id,
        barcode: i.barcode,
        customerNumber: i.customerNumber,
        quality: i.quality,
        size: i.size,
        cost: Number(i.cost || 0),
        creditOwed: i.creditOwed,
      })),
    }));

    return res.json({ returns: safeReturns });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

export default requirePermission("inventory.transfer", handler);
