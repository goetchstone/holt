// /app/src/pages/api/tills/[id]/close.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { PrismaClient } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { sessionStaffMember } from "@/lib/auth/roleAssignment";
import { prisma } from "@/lib/prisma";
import { calculateTillExpected } from "@/lib/paymentService";
import { lockTillForChange } from "@/lib/tillLock";
import { logError } from "@/lib/logger";
import {
  classifyTillVariance,
  hasVarianceNote,
  varianceNoteRequiredMessage,
  applyRegisterVarianceBlock,
} from "@/lib/tillVariance";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure(ish) handler body, exported for unit/integration testing (mirrors
 * the pattern in pages/api/accounting/journal-entries/[id]/reconcile.ts
 * and this route's sibling reconcile.ts). Auth happens in the default
 * export below; this function trusts its caller for that.
 */
export async function handleClose(
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
    if (till.status !== "OPEN") {
      res.status(400).json({ error: `Till is already ${till.status}` });
      return;
    }

    const staff = await sessionStaffMember(session, { id: true }, client);
    if (!staff) {
      res.status(403).json({ error: "Staff member not found" });
      return;
    }

    const { counts, actualCash, notes } = req.body;

    if (actualCash === undefined) {
      res.status(400).json({ error: "actualCash is required" });
      return;
    }

    const parsedActual = round2(Number.parseFloat(actualCash));
    const trimmedNotes = typeof notes === "string" ? notes.trim() : "";

    // Everything that decides the close happens under the till's row lock
    // (lib/tillLock.ts): the till is read again, what it should hold is added
    // up, and the count is written, with nothing booked against the till in
    // between. Before, the sum was taken ahead of the transaction, so a payment
    // landing in that gap was left out of it and showed up as an overage; and
    // two closes at once both passed the check above, the second replacing the
    // first's count.
    const outcome = await client.$transaction(async (tx) => {
      const locked = await lockTillForChange(tx, tillId);
      if (!locked) return { refused: { status: 404, error: "Till not found" } } as const;
      if (locked.status !== "OPEN") {
        return { refused: { status: 400, error: `Till is already ${locked.status}` } } as const;
      }

      const expected = await calculateTillExpected(tillId, tx);
      const variance = round2(parsedActual - expected.expectedCash);

      // Till variance discipline (Phase 0.6, docs/domains/pos.md). Variance is
      // computed HERE (not in reconcile.ts, which only approves an
      // already-computed variance) so the mandatory-note check and the
      // register escalation block both apply at the moment the discrepancy is
      // first known -- waiting until reconcile would let a new till be opened
      // on an over-$100 register in the meantime.
      const classification = classifyTillVariance(variance);
      if (classification.requiresNote && !hasVarianceNote(trimmedNotes)) {
        return {
          refused: { status: 400, error: varianceNoteRequiredMessage(variance) },
        } as const;
      }

      // Remove existing closing counts if re-closing. Opening counts are
      // preserved -- they belong to the open-till moment, not the close.
      await tx.tillCount.deleteMany({ where: { tillId, isOpening: false } });

      // Create denomination counts
      if (Array.isArray(counts) && counts.length > 0) {
        await tx.tillCount.createMany({
          data: counts.map((c: { denomination: string; quantity: number; amount: number }) => ({
            tillId,
            denomination: c.denomination,
            quantity: c.quantity,
            amount: round2(c.amount),
            isOpening: false,
          })),
        });
      }

      const closedTill = await tx.till.update({
        where: { id: tillId },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedById: staff.id,
          expectedCash: expected.expectedCash,
          actualCash: parsedActual,
          variance,
          notes: trimmedNotes || null,
          updatedBy: session.user?.email || null,
        },
        include: {
          register: {
            include: { storeLocation: { select: { name: true } } },
          },
          openedBy: { select: { displayName: true } },
          closedBy: { select: { displayName: true } },
          counts: true,
        },
      });

      // Escalation tier (|variance| > $100): block new opens at this
      // register until a manager clears it. Same transaction as the status
      // flip so the block can never lag behind the CLOSED till it came from.
      await applyRegisterVarianceBlock(tx, {
        registerId: locked.registerId,
        tillId,
        variance,
        classification,
      });

      return { closedTill, expected, classification };
    });

    if (outcome.refused) {
      res.status(outcome.refused.status).json({ error: outcome.refused.error });
      return;
    }
    const { closedTill: updated, expected, classification } = outcome;

    res.status(200).json({
      ...updated,
      openingCash: Number(updated.openingCash),
      expectedCash: Number(updated.expectedCash),
      actualCash: Number(updated.actualCash),
      variance: Number(updated.variance),
      counts: updated.counts.map((c) => ({ ...c, amount: Number(c.amount) })),
      summary: expected,
      varianceClassification: classification,
    });
  } catch (err) {
    logError("POST /tills/[id]/close error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  await handleClose(req, res, session, prisma);
}

// "Open and close tills" (pos.till.manage), the key that opens one
// (registers/[id]/tills/open.ts).
export default requirePermission("pos.till.manage", handler);
