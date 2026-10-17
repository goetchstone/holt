// /app/src/pages/api/inventory/counts/index.ts
//
// Counts by place (lib/inventory/count.ts): those waiting to be posted, with
// what posting each would move now, and the latest posted ones.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { previewCount } from "@/lib/inventory/count";
import { toQty } from "@/lib/inventory/quantity";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const counts = await prisma.stockCount.findMany({
      where: { status: { in: ["SUBMITTED", "POSTED"] } },
      orderBy: [{ status: "desc" }, { countedAt: "desc" }],
      take: 100,
      include: {
        stockLocation: { select: { name: true, storeLocation: { select: { name: true } } } },
        lines: { select: { productId: true, counted: true, expected: true, difference: true } },
      },
    });
    const productIds = [...new Set(counts.flatMap((c) => c.lines.map((l) => l.productId)))];
    const products = new Map(
      (
        await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, productNumber: true },
        })
      ).map((p) => [p.id, p]),
    );
    const out = [];
    for (const c of counts) {
      const lines =
        c.status === "SUBMITTED"
          ? await prisma.$transaction((tx) => previewCount(tx, c.id))
          : c.lines.map((l) => ({
              productId: l.productId,
              counted: toQty(l.counted),
              expected: toQty(l.expected),
              difference: toQty(l.difference),
            }));
      out.push({
        id: c.id,
        status: c.status,
        scope: c.scope,
        place: c.stockLocation.name,
        store: c.stockLocation.storeLocation.name,
        countedAt: c.countedAt,
        countedBy: c.countedBy,
        postedAt: c.postedAt,
        postedBy: c.postedBy,
        lines: lines.map((l) => ({
          productId: l.productId,
          productName: products.get(l.productId)?.name ?? `#${l.productId}`,
          productNumber: products.get(l.productId)?.productNumber ?? "",
          counted: l.counted,
          expected: l.expected,
          difference: l.difference,
        })),
      });
    }
    return res.status(200).json({ counts: out });
  } catch (error) {
    logError("Error listing counts", error);
    return res.status(500).json({ error: "Failed to list counts" });
  }
}

export default requirePermission("inventory.count", handler);
