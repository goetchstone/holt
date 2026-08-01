// /app/src/pages/api/tills/[id]/reconcile.ts
//
// Manager-or-above approval step: CLOSED -> RECONCILED. Variance itself is
// computed in close.ts, not here -- this endpoint approves an
// already-computed variance and (for Phase 0.6 escalation-tier variances)
// re-affirms the register block. See docs/domains/pos.md "Variance
// discipline" and src/lib/tillVariance.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import {
  classifyTillVariance,
  hasVarianceNote,
  varianceNoteRequiredMessage,
  applyRegisterVarianceBlock,
} from "@/lib/tillVariance";

/**
 * Pure(ish) handler body, exported for unit testing against a mocked
 * Prisma client (mirrors pages/api/accounting/journal-entries/[id]/reconcile.ts).
 *
 * The MANAGER/ADMIN role check happens in the requireAuthWithRole wrapper
 * below, using the codebase's existing shared role helper (not reinvented
 * here). That gate already applies to EVERY reconcile regardless of
 * variance size, which is a superset of the Phase 0.6 ">$20 requires
 * manager" rule -- see the PR notes for why this wasn't narrowed to
 * "only >$20 needs a manager."
 */
export async function handleReconcile(
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

  const tillId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(tillId)) {
    res.status(400).json({ error: "Invalid till ID" });
    return;
  }

  try {
    const till = await client.till.findUnique({ where: { id: tillId } });
    if (!till) {
      res.status(404).json({ error: "Till not found" });
      return;
    }
    if (till.status !== "CLOSED") {
      res.status(400).json({ error: "Till must be CLOSED before reconciliation" });
      return;
    }

    const { notes } = req.body;
    const suppliedNotes = typeof notes === "string" ? notes.trim() : "";
    const existingNotes = till.notes ?? "";
    const variance = till.variance ? Number(till.variance) : 0;
    const classification = classifyTillVariance(variance);

    // Defense-in-depth (CLAUDE.md rule 42: a guard present on one mutation
    // path and missing on another is no guard at all). close.ts already
    // refuses to CLOSE a till above the $5 threshold without a note, so in
    // the normal flow this never fires -- it only matters if a till reaches
    // CLOSED some other way (legacy rows, a future bulk path) without one.
    if (
      classification.requiresNote &&
      !hasVarianceNote(suppliedNotes) &&
      !hasVarianceNote(existingNotes)
    ) {
      res.status(400).json({ error: varianceNoteRequiredMessage(variance) });
      return;
    }

    const updated = await client.$transaction(async (tx) => {
      const reconciled = await tx.till.update({
        where: { id: tillId },
        data: {
          status: "RECONCILED",
          notes: suppliedNotes ? `${existingNotes}\n${suppliedNotes}`.trim() : till.notes,
          updatedBy: session.user?.email || null,
        },
      });

      // Re-affirm the escalation-tier register block. Idempotent -- close.ts
      // is the primary path that sets it, this just closes the gap for any
      // till that reached CLOSED without going through close.ts's check.
      await applyRegisterVarianceBlock(tx, {
        registerId: till.registerId,
        tillId,
        variance,
        classification,
      });

      return reconciled;
    });

    res.status(200).json({
      ...updated,
      openingCash: Number(updated.openingCash),
      expectedCash: updated.expectedCash ? Number(updated.expectedCash) : null,
      actualCash: updated.actualCash ? Number(updated.actualCash) : null,
      variance: updated.variance ? Number(updated.variance) : null,
      varianceClassification: classification,
    });
  } catch (err) {
    logError("POST /tills/[id]/reconcile error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  await handleReconcile(req, res, session, prisma);
});
