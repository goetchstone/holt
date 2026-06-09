// /app/src/pages/api/consignment/receiving-gaps.ts
//
// Returns summary counts and item lists for consignment data quality gaps:
// items with no receipt link, items with no store location, and existing receipts.
// Manager-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (session as any)?.role;
  if (role !== "MANAGER" && role !== "ADMIN")
    return res.status(403).json({ error: "Manager role required" });

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
        cost: true,
        receivedDate: true,
        vendor: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      take: limit,
    });
    return res.status(200).json({ items });
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
    return res.status(200).json({ items });
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
