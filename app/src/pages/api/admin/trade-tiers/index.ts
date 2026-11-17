// /app/src/pages/api/admin/trade-tiers/index.ts
//
// The store's trade tiers. A tier prices every eligible line of its customers'
// sales below retail with no manager's PIN (GAP-06 part C, DECISIONS 61), so
// making one is giving a standing discount: it takes "Apply discounts"
// (sales.discount) beside the gate, as giving any other discount does, and it
// is recorded (TRADE_TIER_CHANGED) in the same transaction as the save. The
// percent is 0 to 100 to the hundredth, the scale a line records it at
// (lib/pricing/tradeTier.ts tierPercentProblem).

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { prisma } from "@/lib/prisma";
import { auditActor, auditLog } from "@/lib/audit";
import { tierPercentProblem } from "@/lib/pricing/tradeTier";
import { DISCOUNT_PERMISSION } from "@/lib/sales/discountApproval";

export default requirePermission(
  "catalog.pricing",
  async (req, res, session, access) => {
    if (req.method === "GET") {
      return handleGet(res);
    }
    if (req.method === "POST") {
      return handlePost(req, res, session, access);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  },
  { also: [DISCOUNT_PERMISSION] },
);

async function handleGet(res: NextApiResponse) {
  const tiers = await prisma.tradeTier.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return res.json(tiers);
}

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const { name, discountPercent, sortOrder } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  if (discountPercent == null) {
    return res.status(400).json({ error: "Discount percent is required" });
  }
  const percentProblem = tierPercentProblem(discountPercent);
  if (percentProblem) return res.status(400).json({ error: percentProblem });

  if (!access.holds[DISCOUNT_PERMISSION]) {
    return res.status(403).json({
      error: "Making a trade tier gives a standing discount: it needs Apply discounts.",
    });
  }

  const existing = await prisma.tradeTier.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return res.status(409).json({ error: "A tier with that name already exists" });
  }

  const actor = auditActor(session);
  const tier = await prisma.$transaction(async (tx) => {
    const created = await tx.tradeTier.create({
      data: {
        name: name.trim(),
        discountPercent: Number(discountPercent),
        sortOrder: sortOrder != null ? Number(sortOrder) : 0,
        createdBy: session.user?.email || undefined,
      },
    });
    await auditLog(
      "TRADE_TIER_CHANGED",
      actor,
      {
        summary: `Trade tier ${created.name} made: ${Number(created.discountPercent)}% off retail`,
        details: { tierId: created.id, toPercent: Number(created.discountPercent) },
      },
      tx,
    );
    return created;
  });

  return res.status(201).json(tier);
}
