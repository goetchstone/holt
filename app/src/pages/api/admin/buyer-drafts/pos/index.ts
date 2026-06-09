// /app/src/pages/api/admin/buyer-drafts/pos/index.ts
//
// CRUD on buyer draft purchase orders. ADMIN-only.
//
// GET — list draft POs, with optional ?status=&vendorId= filters.
// POST — create a new draft PO.
//
// All body coercion / validation lives in `lib/buyerDraftRequestBody.ts`
// per CLAUDE.md rule 14. This file is the thin Prisma + HTTP wrapper.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { Prisma, BuyerDraftPoStatus } from "@prisma/client";
import { buildPoCreateData, VALID_PO_STATUSES } from "@/lib/buyerDraftRequestBody";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") return list(req, res);
  if (req.method === "POST") return create(req, res);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
});

async function list(req: NextApiRequest, res: NextApiResponse) {
  const where: Prisma.BuyerDraftPurchaseOrderWhereInput = {};

  const status = req.query.status;
  if (typeof status === "string" && (VALID_PO_STATUSES as readonly string[]).includes(status)) {
    where.status = status as BuyerDraftPoStatus;
  }

  const vendorId = Number.parseInt(String(req.query.vendorId), 10);
  if (Number.isInteger(vendorId)) where.vendorId = vendorId;

  try {
    const pos = await prisma.buyerDraftPurchaseOrder.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, code: true } },
        storeLocation: { select: { id: true, name: true, code: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ created: "desc" }],
      take: 500,
    });
    return res.status(200).json({ pos });
  } catch (err) {
    logError("buyer-drafts/pos list failed", err);
    return res.status(500).json({ error: "Failed to list draft POs" });
  }
}

async function create(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as Record<string, unknown>;
  const createdBy = req.headers["x-holt-user"]?.toString() ?? null;

  let data;
  try {
    data = buildPoCreateData(body, createdBy);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
  }

  try {
    const created = await prisma.buyerDraftPurchaseOrder.create({ data });
    return res.status(201).json({ po: created });
  } catch (err) {
    logError("buyer-drafts/pos create failed", err);
    return res.status(500).json({ error: "Failed to create draft PO" });
  }
}
