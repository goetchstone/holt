// /app/src/pages/api/admin/buyer-drafts/pos/[id].ts
//
// Single draft PO: GET / PATCH / DELETE. ADMIN-only.
//
// Body coercion + validation lives in `lib/buyerDraftRequestBody.ts` per
// CLAUDE.md rule 14. This file is the thin Prisma + HTTP wrapper.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildPoUpdateData } from "@/lib/buyerDraftRequestBody";

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
    const po = await prisma.buyerDraftPurchaseOrder.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, name: true, code: true } },
        storeLocation: { select: { id: true, name: true, code: true } },
        items: {
          include: {
            stockLocation: { select: { id: true, code: true, name: true } },
            department: { select: { id: true, name: true } },
            category: { select: { id: true, name: true } },
            type: { select: { id: true, name: true } },
          },
          orderBy: [{ partNumber: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!po) return res.status(404).json({ error: "Not found" });
    return res.status(200).json({ po });
  } catch (err) {
    logError("buyer-drafts/pos get failed", err);
    return res.status(500).json({ error: "Failed to fetch draft PO" });
  }
}

async function update(id: number, req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as Record<string, unknown>;
  const updatedBy = req.headers["x-holt-user"]?.toString() ?? null;

  let data;
  try {
    data = buildPoUpdateData(body, updatedBy);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
  }

  try {
    const updated = await prisma.buyerDraftPurchaseOrder.update({ where: { id }, data });
    return res.status(200).json({ po: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Record to update not found")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("buyer-drafts/pos update failed", err);
    return res.status(500).json({ error: "Failed to update draft PO" });
  }
}

async function remove(id: number, res: NextApiResponse) {
  try {
    // Detach items rather than cascade-delete — losing line-item drafts on
    // a PO delete would lose work. The items live on with draftPoId=null.
    await prisma.$transaction([
      prisma.buyerDraftItem.updateMany({
        where: { draftPoId: id },
        data: { draftPoId: null },
      }),
      prisma.buyerDraftPurchaseOrder.delete({ where: { id } }),
    ]);
    return res.status(204).end();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Record to delete does not exist")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("buyer-drafts/pos delete failed", err);
    return res.status(500).json({ error: "Failed to delete draft PO" });
  }
}
