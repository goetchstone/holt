// /app/src/pages/api/admin/buyer-drafts/search-purchase-orders.ts
//
// Slice 6.13 (2026-05-22) — Search real PurchaseOrders by PON / vendor /
// date for the "Import historical PO into a buy" admin modal.
//
// Returns a flat list of POs matching the query, with a flag for those
// already imported into ANY buy (the `@unique BuyerDraftPurchaseOrder
// .importedFromPurchaseOrderId` makes this a single indexed lookup).
//
// ADMIN-only — buyer-drafts is admin-scoped per the existing pattern.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

const MAX_RESULTS = 50;

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    const where: Prisma.PurchaseOrderWhereInput = {};

    // Exclude cancelled POs by default — they're not real buys.
    where.status = { not: "CANCELLED" };

    if (q.length > 0) {
      where.OR = [
        { poNumber: { contains: q, mode: "insensitive" } },
        { vendor: { name: { contains: q, mode: "insensitive" } } },
      ];
    }

    if (startDate || endDate) {
      where.orderDate = {};
      if (startDate) where.orderDate.gte = startDate;
      if (endDate) where.orderDate.lte = endDate;
    }

    const pos = await prisma.purchaseOrder.findMany({
      where,
      select: {
        id: true,
        poNumber: true,
        orderDate: true,
        status: true,
        expectedDelivery: true,
        estimatedShipDate: true,
        vendor: { select: { id: true, name: true } },
        _count: { select: { lineItems: true } },
        // Buyer-draft link back-relation (Slice 6.14). Set => already
        // linked to a draft PO somewhere. Pull the buy's id + name for
        // display so the modal can show "Already in <Buy>".
        buyerDraftLink: {
          select: {
            draftPo: {
              select: { id: true, buyId: true, buy: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: [{ orderDate: "desc" }, { id: "desc" }],
      take: MAX_RESULTS,
    });

    const results = pos.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      orderDate: po.orderDate.toISOString(),
      status: po.status,
      expectedDelivery: po.expectedDelivery ? po.expectedDelivery.toISOString() : null,
      estimatedShipDate: po.estimatedShipDate ? po.estimatedShipDate.toISOString() : null,
      vendor: po.vendor,
      lineCount: po._count.lineItems,
      alreadyImported: po.buyerDraftLink
        ? {
            draftPoId: po.buyerDraftLink.draftPo.id,
            buyId: po.buyerDraftLink.draftPo.buyId ?? null,
            buyName: po.buyerDraftLink.draftPo.buy?.name ?? null,
          }
        : null,
    }));

    return res.status(200).json({ results, capped: results.length >= MAX_RESULTS });
  } catch (err) {
    logError("[buyer-drafts/search-purchase-orders] unexpected error", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
