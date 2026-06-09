// /app/src/pages/api/admin/buyer-drafts/items/index.ts
//
// CRUD on buyer draft items. ADMIN-only.
//
// GET — list draft items, with optional ?status=&vendorId=&draftPoId= filters.
// POST — create a new draft item.
//
// All body coercion / validation lives in `lib/buyerDraftRequestBody.ts`
// per CLAUDE.md rule 14. This file is the thin Prisma + HTTP wrapper.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { Prisma, BuyerDraftItemStatus } from "@prisma/client";
import { buildItemCreateData, VALID_ITEM_STATUSES } from "@/lib/buyerDraftRequestBody";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") return list(req, res);
  if (req.method === "POST") return create(req, res);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
});

async function list(req: NextApiRequest, res: NextApiResponse) {
  const where: Prisma.BuyerDraftItemWhereInput = {};

  const status = req.query.status;
  if (typeof status === "string" && (VALID_ITEM_STATUSES as readonly string[]).includes(status)) {
    where.status = status as BuyerDraftItemStatus;
  }

  const vendorId = Number.parseInt(String(req.query.vendorId), 10);
  if (Number.isInteger(vendorId)) where.vendorId = vendorId;

  const draftPoId = Number.parseInt(String(req.query.draftPoId), 10);
  if (Number.isInteger(draftPoId)) where.draftPoId = draftPoId;

  try {
    const items = await prisma.buyerDraftItem.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        type: { select: { id: true, name: true } },
        stockLocation: { select: { id: true, code: true, name: true } },
        draftPo: { select: { id: true, referenceNumber: true } },
        vendorStyle: { select: { id: true, styleNumber: true, name: true } },
        // Slice 6.1 (2026-05-12) — when a draft is linked to a real
        // Product (via Slice 5 auto-link or a manual link), surface the
        // catalog's data so the buyer can verify "is this the catalog
        // item I planned?" Also serves the historical/testing case
        // where the buyer drafts an item that already exists in the
        // catalog — we render the catalog description as a fallback.
        fulfilledProduct: {
          select: {
            id: true,
            productNumber: true,
            name: true,
            description: true,
            baseCost: true,
            baseRetail: true,
            mapPrice: true,
            width: true,
            depth: true,
            height: true,
          },
        },
      },
      orderBy: [{ vendorName: "asc" }, { partNumber: "asc" }, { id: "asc" }],
      take: 1000, // cap so a forgotten filter doesn't dump 50K rows on the iPad
    });
    return res.status(200).json({ items });
  } catch (err) {
    logError("buyer-drafts list failed", err);
    return res.status(500).json({ error: "Failed to list draft items" });
  }
}

async function create(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as Record<string, unknown>;
  const createdBy = req.headers["x-holt-user"]?.toString() ?? null;

  let data;
  try {
    data = buildItemCreateData(body, createdBy);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
  }

  try {
    const created = await prisma.buyerDraftItem.create({ data });
    return res.status(201).json({ item: created });
  } catch (err) {
    logError("buyer-drafts create failed", err);
    return res.status(500).json({ error: "Failed to create draft item" });
  }
}
