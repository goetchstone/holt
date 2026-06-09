// /app/src/pages/api/admin/buyer-drafts/items/[id].ts
//
// Single draft item: GET / PATCH / DELETE. ADMIN-only.
//
// PATCH accepts a partial body — only the keys present in the body are
// updated. Body coercion + validation lives in `lib/buyerDraftRequestBody.ts`
// per CLAUDE.md rule 14; this file is the thin Prisma + HTTP wrapper.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildItemUpdateData } from "@/lib/buyerDraftRequestBody";
import { isCompatiblePoForItem } from "@/lib/buyerDraftValidation";

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
    const item = await prisma.buyerDraftItem.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        type: { select: { id: true, name: true } },
        stockLocation: { select: { id: true, code: true, name: true } },
        draftPo: { select: { id: true, referenceNumber: true } },
        vendorStyle: { select: { id: true, styleNumber: true, name: true } },
      },
    });
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.status(200).json({ item });
  } catch (err) {
    logError("buyer-drafts get failed", err);
    return res.status(500).json({ error: "Failed to fetch draft item" });
  }
}

async function update(id: number, req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as Record<string, unknown>;
  const updatedBy = req.headers["x-holt-user"]?.toString() ?? null;

  let data;
  try {
    data = buildItemUpdateData(body, updatedBy);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
  }

  const vendorMismatch = await checkCrossVendorDrop(id, data);
  if (vendorMismatch !== null) {
    return res.status(400).json({ error: vendorMismatch });
  }

  try {
    const updated = await prisma.buyerDraftItem.update({ where: { id }, data });
    return res.status(200).json({ item: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Record to update not found")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("buyer-drafts update failed", err);
    return res.status(500).json({ error: "Failed to update draft item" });
  }
}

/** Run the cross-vendor drop guard for a PATCH body. Returns the
 *  rejection reason when the patch would put an item under a PO with
 *  a different vendor; null when the patch is fine (no draftPo change,
 *  disconnect, vendor match, or null-side lenient). */
async function checkCrossVendorDrop(
  itemId: number,
  data: { draftPo?: unknown },
): Promise<string | null> {
  if (!("draftPo" in data)) return null;
  const targetPoId = extractConnectId(data.draftPo);
  if (targetPoId === undefined || targetPoId === null) return null;
  const [item, po] = await Promise.all([
    prisma.buyerDraftItem.findUnique({ where: { id: itemId }, select: { vendorId: true } }),
    prisma.buyerDraftPurchaseOrder.findUnique({
      where: { id: targetPoId },
      select: { vendorId: true },
    }),
  ]);
  if (!item || !po) return null;
  const compat = isCompatiblePoForItem(item, po);
  return compat.ok ? null : compat.reason;
}

/** Pull the connect id out of a Prisma `connect | disconnect` relation
 *  patch. Returns `null` for disconnect, the id for connect, `undefined`
 *  when neither (i.e. the field wasn't in the patch at all). */
function extractConnectId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (
    value !== null &&
    typeof value === "object" &&
    "disconnect" in value &&
    (value as { disconnect?: unknown }).disconnect === true
  ) {
    return null;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "connect" in value &&
    typeof (value as { connect?: { id?: unknown } }).connect?.id === "number"
  ) {
    return (value as { connect: { id: number } }).connect.id;
  }
  return undefined;
}

async function remove(id: number, res: NextApiResponse) {
  try {
    await prisma.buyerDraftItem.delete({ where: { id } });
    return res.status(204).end();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Record to delete does not exist")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("buyer-drafts delete failed", err);
    return res.status(500).json({ error: "Failed to delete draft item" });
  }
}
