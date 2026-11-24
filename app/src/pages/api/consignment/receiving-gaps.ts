// /app/src/pages/api/consignment/receiving-gaps.ts
//
// Returns summary counts and item lists for consignment data quality gaps:
// items with no receipt link, items with no store location, and existing receipts.
// On "View accounting", the key of the Receiving Gaps page, its one caller; a
// rug's cost only for a holder of "View cost". Until 2026-11 it was "Write
// purchase orders" plus a check that the staff role was MANAGER or ADMIN by
// name, which refused the Owner, the General Manager and every custom role.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { prisma } from "@/lib/prisma";

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  const showCost = canViewCost(access);
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const type = req.query.type as string | undefined;
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 500, 1000);

  if (type === "unlinked") {
    const items = await prisma.consignmentItem.findMany({
      where: { consignmentReceiptId: null },
      select: {
        id: true,
        barcode: true,
        customerNumber: true,
        quality: true,
        size: true,
        status: true,
        // A rug's cost only for a holder of "View cost".
        cost: showCost,
        receivedDate: true,
        vendor: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      take: limit,
    });
    return res.status(200).json({ items, costVisible: showCost });
  }

  if (type === "unlocated") {
    const items = await prisma.consignmentItem.findMany({
      where: { storeLocationId: null },
      select: {
        id: true,
        barcode: true,
        customerNumber: true,
        quality: true,
        size: true,
        status: true,
        consignmentReceiptId: true,
        vendor: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      take: limit,
    });
    return res.status(200).json({ items, costVisible: showCost });
  }

  // Summary: counts + receipts list
  const [unlinkedCount, unlocatedCount, receipts] = await Promise.all([
    prisma.consignmentItem.count({ where: { consignmentReceiptId: null } }),
    prisma.consignmentItem.count({ where: { storeLocationId: null } }),
    prisma.consignmentReceipt.findMany({
      include: {
        _count: { select: { items: true } },
        vendor: { select: { name: true } },
      },
      orderBy: { receiptDate: "desc" },
    }),
  ]);

  return res.status(200).json({
    unlinkedCount,
    unlocatedCount,
    receipts: receipts.map((r) => ({
      id: r.id,
      receiptDate: r.receiptDate,
      manifestRef: r.manifestRef,
      vendorName: r.vendor.name,
      claimedCount: r.itemCount,
      actualCount: r._count.items,
    })),
  });
}

export default requirePermission("accounting.read", handler, WITH_COST);
