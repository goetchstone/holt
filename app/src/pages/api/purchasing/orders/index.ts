// /app/src/pages/api/purchasing/orders/index.ts
//
//   GET  the purchase-order list for /app/purchasing/orders, with totals.
//        Gated on purchasing.read ("View purchasing"), the key that page is on
//        (pagePermissions.ts). A service case finds a PO to link through its
//        own narrower route, /api/service/purchase-order-lookup (service.write).
//   POST a stock PO a buyer writes by hand (GAP-01), as a draft:
//        { vendorId, shipToLocationId, expectedDelivery, notes, lines } ->
//        { id, poNumber }. "Write purchase orders" (purchasing.write).

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import { parseNewPo } from "@/lib/purchasing/purchaseOrderShared";
import { PurchaseOrderError, createStockPurchaseOrder } from "@/lib/purchasing/stockPurchaseOrder";

/** Exported for integration tests. */
export async function createHandler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const input = parseNewPo(req.body);
  if (!input.ok) return res.status(400).json({ error: input.problem });
  try {
    const created = await createStockPurchaseOrder(input.value, {
      actor: session.user?.email ?? null,
      canSetCost: canViewCost(access),
    });
    return res.status(201).json(created);
  } catch (err) {
    if (err instanceof PurchaseOrderError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("Error creating purchase order", err);
    return res.status(500).json({ error: "Failed to create the purchase order." });
  }
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const showCost = canViewCost(access);
  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string)?.trim() || "";

    const skip = (page - 1) * limit;

    const isReturnFilter = req.query.isReturn as string | undefined;

    const where: Prisma.PurchaseOrderWhereInput = {
      ...(isReturnFilter === "true" ? { isReturn: true } : {}),
      ...(isReturnFilter === "false" ? { isReturn: false } : {}),
      ...(search
        ? {
            OR: [
              { poNumber: { contains: search, mode: "insensitive" } },
              { vendor: { name: { contains: search, mode: "insensitive" } } },
              { notes: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { orderDate: "desc" },
        include: {
          vendor: { select: { id: true, name: true } },
          lineItems: {
            select: {
              orderedQuantity: true,
              unitCost: true,
              _count: { select: { receivingRecords: true } },
            },
          },
        },
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    const safeOrders = orders.map((po) => {
      const lineItemCount = po.lineItems.length;
      const totalCost = po.lineItems.reduce(
        (sum, item) => sum + Number(item.orderedQuantity) * Number(item.unitCost),
        0,
      );
      const receivedItemCount = po.lineItems.filter(
        (item) => item._count.receivingRecords > 0,
      ).length;

      return {
        id: po.id,
        poNumber: po.poNumber,
        vendorName: po.vendor.name,
        orderDate: po.orderDate,
        expectedDelivery: po.expectedDelivery,
        status: po.status,
        isReturn: po.isReturn,
        lineItemCount,
        ...(showCost ? { totalCost } : {}),
        receivedItemCount,
      };
    });

    return res.status(200).json({ orders: safeOrders, total, costVisible: showCost });
  } catch (error) {
    logError("Error fetching purchase orders", error);
    return res.status(500).json({ error: "Failed to fetch purchase orders" });
  }
}

// PO totals for a holder of "View cost"; the list without them for anyone else.
const readGate = requirePermission("purchasing.read", handler, WITH_COST);
// Writing a PO; a writer without "View cost" gets the catalog's costs.
const writeGate = requirePermission("purchasing.write", createHandler, WITH_COST);

export default async function route(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") return writeGate(req, res);
  return readGate(req, res);
}
