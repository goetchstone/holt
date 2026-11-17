// /app/src/pages/api/admin/trade-tiers/[id].ts
//
// Changing or turning off a trade tier. A tier's percent and whether it is on
// decide what every customer on it pays (GAP-06 part C, DECISIONS 61), so a
// change to either takes "Apply discounts" (sales.discount) beside the gate and
// is recorded (TRADE_TIER_CHANGED) in the same transaction as the save. A
// rename or a new sort order moves no money and takes the gate alone. The
// percent is 0 to 100 to the hundredth (lib/pricing/tradeTier.ts).

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { prisma } from "@/lib/prisma";
import { auditActor, auditLog } from "@/lib/audit";
import { tierPercentProblem } from "@/lib/pricing/tradeTier";
import { DISCOUNT_PERMISSION } from "@/lib/sales/discountApproval";

export default requirePermission(
  "catalog.pricing",
  async (req, res, session, access) => {
    const id = Number.parseInt(req.query.id as string);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid tier ID" });
    }

    if (req.method === "PUT") {
      return handlePut(id, req, res, session, access);
    }
    if (req.method === "DELETE") {
      return handleDelete(id, res, session);
    }
    res.setHeader("Allow", "PUT, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  },
  { also: [DISCOUNT_PERMISSION] },
);

const percentText = (p: unknown) => `${Number(p)}% off retail`;

/** Why a tier change can't be saved as sent, or null. */
function putProblem(body: { name?: unknown; discountPercent?: unknown; isActive?: unknown }) {
  const { name, discountPercent, isActive } = body;
  if (name != null && (typeof name !== "string" || !name.trim())) return "Name cannot be empty";
  if (discountPercent != null) {
    const percentProblem = tierPercentProblem(discountPercent);
    if (percentProblem) return percentProblem;
  }
  if (isActive != null && typeof isActive !== "boolean") return "isActive must be true or false";
  return null;
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const existing = await prisma.tradeTier.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Tier not found" });
  }

  const { name, discountPercent, sortOrder, isActive } = req.body;

  const problem = putProblem(req.body);
  if (problem) return res.status(400).json({ error: problem });

  // What the save does to the money: a new percent, or the tier turned on or off.
  const percentMoves =
    discountPercent != null && Number(discountPercent) !== Number(existing.discountPercent);
  const activeMoves = isActive != null && isActive !== existing.isActive;
  if ((percentMoves || (activeMoves && isActive)) && !access.holds[DISCOUNT_PERMISSION]) {
    return res.status(403).json({
      error: "A trade tier's percent is a standing discount: changing it needs Apply discounts.",
    });
  }

  // Check uniqueness if name is being changed
  if (name && name.trim() !== existing.name) {
    const duplicate = await prisma.tradeTier.findUnique({ where: { name: name.trim() } });
    if (duplicate) {
      return res.status(409).json({ error: "A tier with that name already exists" });
    }
  }

  const tier = await prisma.$transaction(async (tx) => {
    const updated = await tx.tradeTier.update({
      where: { id },
      data: {
        ...(name != null && { name: name.trim() }),
        ...(discountPercent != null && { discountPercent: Number(discountPercent) }),
        ...(sortOrder != null && { sortOrder: Number(sortOrder) }),
        ...(isActive != null && { isActive }),
        updatedBy: session.user?.email || undefined,
      },
    });
    if (percentMoves || activeMoves) {
      await recordTierChange(tx, auditActor(session), existing, updated);
    }
    return updated;
  });

  return res.json(tier);
}

type TierRow = { name: string; discountPercent: unknown; isActive: boolean };

/** A tier's percent or on/off changed: who changed it, from what, to what. */
async function recordTierChange(
  tx: Prisma.TransactionClient,
  actor: string,
  before: TierRow & { id: number },
  after: TierRow,
) {
  const parts: string[] = [];
  if (Number(before.discountPercent) !== Number(after.discountPercent)) {
    parts.push(`${percentText(before.discountPercent)} → ${percentText(after.discountPercent)}`);
  }
  if (before.isActive !== after.isActive) parts.push(after.isActive ? "turned on" : "turned off");
  await auditLog(
    "TRADE_TIER_CHANGED",
    actor,
    {
      summary: `Trade tier ${after.name}: ${parts.join(", ")}`,
      details: {
        tierId: before.id,
        fromPercent: Number(before.discountPercent),
        toPercent: Number(after.discountPercent),
        fromActive: before.isActive,
        toActive: after.isActive,
      },
    },
    tx,
  );
}

async function handleDelete(id: number, res: NextApiResponse, session: Session) {
  const existing = await prisma.tradeTier.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Tier not found" });
  }

  // Soft delete by deactivating. Turning a tier off only takes a discount away,
  // so it takes the gate alone; it is still recorded.
  const tier = await prisma.$transaction(async (tx) => {
    const updated = await tx.tradeTier.update({
      where: { id },
      data: {
        isActive: false,
        updatedBy: session.user?.email || undefined,
      },
    });
    if (existing.isActive) {
      await auditLog(
        "TRADE_TIER_CHANGED",
        auditActor(session),
        {
          summary: `Trade tier ${updated.name}: turned off`,
          details: { tierId: id, fromActive: true, toActive: false },
        },
        tx,
      );
    }
    return updated;
  });

  return res.json(tier);
}
