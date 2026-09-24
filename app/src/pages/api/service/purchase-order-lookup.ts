// /app/src/pages/api/service/purchase-order-lookup.ts
//
// The purchase-order search behind "Link PO" on a service case task
// (CaseDetailView). Gated on service.write, the key of the action it serves:
// saving the link (PUT /api/service/tasks/[id]) and loading the case
// (GET /api/service/cases/[id]) already require it. Service staff need to find
// a PO by number or vendor; they get only that, never PO totals, cost, status
// or a search over notes, which stay with the purchasing list
// (/api/purchasing/orders, purchasing.read).

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

const MAX_RESULTS = 10;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (!search) return res.status(200).json({ orders: [] });

  try {
    const orders = await prisma.purchaseOrder.findMany({
      where: {
        OR: [
          { poNumber: { contains: search, mode: "insensitive" } },
          { vendor: { name: { contains: search, mode: "insensitive" } } },
        ],
      },
      orderBy: { orderDate: "desc" },
      take: MAX_RESULTS,
      select: { id: true, poNumber: true, vendor: { select: { name: true } } },
    });

    return res.status(200).json({
      orders: orders.map((po) => ({
        id: po.id,
        poNumber: po.poNumber,
        vendorName: po.vendor.name,
      })),
    });
  } catch (err) {
    logError("GET /service/purchase-order-lookup error", err);
    return res.status(500).json({ error: "Failed to search purchase orders" });
  }
}

export default requirePermission("service.write", handler);
