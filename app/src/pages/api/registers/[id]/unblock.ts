// /app/src/pages/api/registers/[id]/unblock.ts
//
// Clears a Phase 0.6 till-variance escalation block on a register (see
// docs/domains/pos.md and src/lib/tillVariance.ts). MANAGER/ADMIN only --
// the same role tier that's already required to reconcile the till that
// caused the block in the first place (pages/api/tills/[id]/reconcile.ts).
//
// Requires a `resolutionNote` explaining what was done about the
// discrepancy (recount, found the missing drop slip, confirmed genuine
// shortage and filed a loss report, etc.) -- clearing an escalation is
// itself a control point, not a rubber stamp. The note is appended to
// `blockReason` (not wiped) so the register's escalation history survives
// the clear; only `blockedAt` goes back to null, which is what actually
// un-blocks new opens.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { PrismaClient } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

/**
 * Pure(ish) handler body, exported for unit/integration testing (mirrors
 * the sibling till routes). The capability check happens in the
 * requirePermission wrapper below.
 */
export async function handleUnblock(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  client: PrismaClient,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  const registerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(registerId)) {
    res.status(400).json({ error: "Invalid register ID" });
    return;
  }

  const { resolutionNote } = req.body as { resolutionNote?: string };
  const trimmedNote = typeof resolutionNote === "string" ? resolutionNote.trim() : "";
  if (!trimmedNote) {
    res
      .status(400)
      .json({ error: "resolutionNote is required to clear a register's variance block" });
    return;
  }

  try {
    const register = await client.register.findUnique({ where: { id: registerId } });
    if (!register) {
      res.status(404).json({ error: "Register not found" });
      return;
    }
    if (!register.blockedAt) {
      res.status(400).json({ error: "Register is not currently blocked" });
      return;
    }

    const clearedBy = session.user?.email || "unknown";
    const updated = await client.register.update({
      where: { id: registerId },
      data: {
        blockedAt: null,
        blockReason:
          `${register.blockReason ?? ""}\n\nCleared by ${clearedBy} at ${new Date().toISOString()}: ${trimmedNote}`.trim(),
        updatedBy: clearedBy,
      },
    });

    res.status(200).json(updated);
  } catch (err) {
    logError(`POST /registers/${registerId}/unblock error`, err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export default requirePermission("pos.till.adjust", async (req, res, session) => {
  await handleUnblock(req, res, session, prisma);
});
