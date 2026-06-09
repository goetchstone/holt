// /app/src/pages/api/admin/buyer-drafts/buys/index.ts
//
// CRUD-list on buyer Buys (the parent table that groups POs for a
// season / event so the buyer can plan and review historical buys).
// ADMIN-only. List + create.
//
// Body coercion + validation lives in `lib/buyerDraftRequestBody.ts`
// per CLAUDE.md rule 14 — this file is the thin Prisma + HTTP wrapper.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { Prisma, BuyerDraftBuyStatus } from "@prisma/client";
import { buildBuyCreateData, VALID_BUY_STATUSES } from "@/lib/buyerDraftRequestBody";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") return list(req, res);
  if (req.method === "POST") return create(req, res);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
});

async function list(req: NextApiRequest, res: NextApiResponse) {
  const where: Prisma.BuyerDraftBuyWhereInput = {};

  const status = req.query.status;
  if (typeof status === "string" && (VALID_BUY_STATUSES as readonly string[]).includes(status)) {
    where.status = status as BuyerDraftBuyStatus;
  }

  const year = Number.parseInt(String(req.query.year), 10);
  if (Number.isInteger(year)) where.year = year;

  try {
    const buys = await prisma.buyerDraftBuy.findMany({
      where,
      include: {
        _count: { select: { pos: true } },
      },
      orderBy: [{ year: "desc" }, { created: "desc" }],
      take: 200,
    });
    return res.status(200).json({ buys });
  } catch (err) {
    logError("buyer-drafts/buys list failed", err);
    return res.status(500).json({ error: "Failed to list buys" });
  }
}

async function create(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as Record<string, unknown>;
  const createdBy = req.headers["x-holt-user"]?.toString() ?? null;

  let data;
  try {
    data = buildBuyCreateData(body, createdBy);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
  }

  try {
    const created = await prisma.buyerDraftBuy.create({ data });
    return res.status(201).json({ buy: created });
  } catch (err) {
    logError("buyer-drafts/buys create failed", err);
    return res.status(500).json({ error: "Failed to create buy" });
  }
}
