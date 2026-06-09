// /app/src/pages/api/admin/reports/commission-payouts/[id].ts
//
// SUPER_ADMIN-only. Operations on one payout:
//
//   - GET    → return payout + its edit history (audit log)
//   - PATCH  { reason, commissionAmount?, notes?, paidOn?, lockedAt? }
//             Edit-with-audit. Every changed field writes a
//             CommissionPayoutEdit row. `reason` is required.
//             To lock or unlock, pass lockedAt: Date (lock) or null
//             (unlock). Both transitions record an audit entry.
//
// Origin: owner direction 2026-05-27 — "SUPER_ADMIN can edit with an
// audit comment."

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { editPayout, type PayoutPatch } from "@/lib/runCommissionPayouts";
import { logError } from "@/lib/logger";

interface PatchBody {
  reason?: string;
  commissionAmount?: number;
  notes?: string | null;
  paidOn?: string | null;
  lockedAt?: string | null;
}

/** Translate the loose JSON body shape into the typed PayoutPatch. */
function buildPayoutPatch(body: PatchBody): PayoutPatch {
  const patch: PayoutPatch = {};
  if (Object.hasOwn(body, "commissionAmount")) {
    patch.commissionAmount = Number(body.commissionAmount);
  }
  if (Object.hasOwn(body, "notes")) {
    patch.notes = body.notes;
  }
  if (Object.hasOwn(body, "paidOn")) {
    patch.paidOn = body.paidOn ? new Date(body.paidOn) : null;
  }
  if (Object.hasOwn(body, "lockedAt")) {
    patch.lockedAt = body.lockedAt ? new Date(body.lockedAt) : null;
  }
  return patch;
}

/** PATCH error → user-facing message + HTTP status. */
function describePatchError(err: unknown): { status: number; message: string } {
  if (err instanceof Error && err.message === "payout not found") {
    return { status: 404, message: "Payout not found" };
  }
  if (err instanceof Error && err.message === "audit reason is required") {
    return { status: 400, message: "An audit reason is required" };
  }
  return { status: 400, message: "Failed to update payout" };
}

const PAYOUT_INCLUDE = {
  staffMember: { select: { id: true, displayName: true } },
  edits: { orderBy: { editedAt: "desc" } },
} as const;

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const payout = await prisma.commissionPayout.findUnique({
      where: { id },
      include: PAYOUT_INCLUDE,
    });
    if (!payout) return res.status(404).json({ error: "Payout not found" });
    return res.status(200).json({ payout });
  } catch (err) {
    logError("commission-payouts GET[id] failed", err);
    return res.status(500).json({ error: "Failed to load payout" });
  }
}

async function handlePatch(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  actorEmail: string,
) {
  try {
    const body = (req.body || {}) as PatchBody;
    const reason = (body.reason || "").trim();
    if (!reason) {
      return res
        .status(400)
        .json({ error: "An audit reason is required for every edit on a locked payout" });
    }
    const patch = buildPayoutPatch(body);
    const result = await editPayout(id, patch, { reason, editedBy: actorEmail });
    const updated = await prisma.commissionPayout.findUnique({
      where: { id },
      include: PAYOUT_INCLUDE,
    });
    return res.status(200).json({ result, payout: updated });
  } catch (err) {
    logError("commission-payouts PATCH failed", err);
    const { status, message } = describePatchError(err);
    return res.status(status).json({ error: message });
  }
}

export default requireAuthWithRole(
  ["SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const id = Number.parseInt(String(req.query.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid payout id" });
    }
    const actorEmail = session?.user?.email || "unknown";

    if (req.method === "GET") return handleGet(id, res);
    if (req.method === "PATCH") return handlePatch(id, req, res, actorEmail);

    res.setHeader("Allow", ["GET", "PATCH"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
