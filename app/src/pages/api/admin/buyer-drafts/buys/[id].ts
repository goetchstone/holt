// /app/src/pages/api/admin/buyer-drafts/buys/[id].ts
//
// Single Buy: GET / PATCH / DELETE. ADMIN-only.
//
// GET includes per-Buy rollup metrics (PO count, item count, sum of
// qty × cost) so the workbench page can render a budget-vs-spent bar
// without a second round trip.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildBuyUpdateData } from "@/lib/buyerDraftRequestBody";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  const id = Number.parseInt(String(req.query.id), 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  if (req.method === "GET") return getOne(id, res);
  if (req.method === "PATCH") return update(id, req, res);
  if (req.method === "DELETE") return remove(id, res);
  res.setHeader("Allow", ["GET", "PATCH", "DELETE"]);
  return res.status(405).end();
});

async function getOne(id: number, res: NextApiResponse) {
  try {
    const buy = await prisma.buyerDraftBuy.findUnique({
      where: { id },
      include: {
        pos: {
          include: {
            vendor: { select: { id: true, name: true, code: true } },
            _count: { select: { items: true } },
          },
          orderBy: [{ created: "desc" }],
        },
      },
    });
    if (!buy) return res.status(404).json({ error: "Not found" });

    // Compute spent total (sum of qty × cost across all items in all
    // POs under this buy). Single aggregate query — fast.
    const spent = await prisma.buyerDraftItem.aggregate({
      where: { draftPo: { buyId: id } },
      _sum: {
        // We can't sum qty × cost directly; pull both and sum on the
        // client side for accuracy. For an aggregate-only metric we'd
        // need raw SQL; the row count here is small (POs per Buy × items
        // per PO) so a roundtrip via findMany + reduce is fine.
        qty: true,
      },
    });
    const items = await prisma.buyerDraftItem.findMany({
      where: { draftPo: { buyId: id } },
      select: { qty: true, cost: true },
    });
    const totalSpent = items.reduce((acc, it) => acc + it.qty * Number(it.cost), 0);

    return res.status(200).json({
      buy,
      rollup: {
        poCount: buy.pos.length,
        itemCount: spent._sum.qty ?? 0,
        totalSpent: Math.round(totalSpent * 100) / 100,
      },
    });
  } catch (err) {
    logError("buyer-drafts/buys get failed", err);
    return res.status(500).json({ error: "Failed to fetch buy" });
  }
}

async function update(id: number, req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as Record<string, unknown>;
  const updatedBy = req.headers["x-holt-user"]?.toString() ?? null;

  let data;
  try {
    data = buildBuyUpdateData(body, updatedBy);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
  }

  try {
    const updated = await prisma.buyerDraftBuy.update({ where: { id }, data });
    return res.status(200).json({ buy: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Record to update not found")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("buyer-drafts/buys update failed", err);
    return res.status(500).json({ error: "Failed to update buy" });
  }
}

async function remove(id: number, res: NextApiResponse) {
  try {
    // Detach POs (don't cascade delete — losing the linked POs would lose
    // the buyer's work). The FK has ON DELETE SET NULL, but we do this
    // explicitly so the response includes the right error if the buy is
    // already gone.
    await prisma.$transaction([
      prisma.buyerDraftPurchaseOrder.updateMany({
        where: { buyId: id },
        data: { buyId: null },
      }),
      prisma.buyerDraftBuy.delete({ where: { id } }),
    ]);
    return res.status(204).end();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Record to delete does not exist")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("buyer-drafts/buys delete failed", err);
    return res.status(500).json({ error: "Failed to delete buy" });
  }
}
