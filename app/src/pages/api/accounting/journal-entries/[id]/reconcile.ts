// /app/src/pages/api/accounting/journal-entries/[id]/reconcile.ts
//
// Phase 0 control C1: runs the reconciliation for a specific journal
// entry's date. Triggered by a button on the JE detail page rather
// than a cron -- the reconciliation is most useful at the moment the
// accountant is about to export, not on a schedule.
//
// MANAGER/ADMIN only -- the result drives the decision to export.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { computeDailyReconciliation } from "@/lib/dailyReconciliation";
import { logError, logger } from "@/lib/logger";

/**
 * Pure handler body, exported for unit testing. Takes the Prisma client
 * as a parameter so tests can inject a mock without touching the auth
 * wrapper. Returns nothing -- side effects go through res.
 *
 * Auth + role check happens in the wrapper below; this function trusts
 * its caller for that.
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

  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid journal entry id" });
    return;
  }

  try {
    // Look up the JE to find its date
    const je = await client.journalEntry.findUnique({
      where: { id },
      select: { id: true, journalDate: true, status: true, journalNumber: true },
    });
    if (!je) {
      res.status(404).json({ error: "Journal entry not found" });
      return;
    }

    const startedAt = Date.now();
    const result = await computeDailyReconciliation({
      date: je.journalDate,
      client,
    });
    const durationMs = Date.now() - startedAt;

    // Persist the result
    await client.dailyReconciliationLog.create({
      data: {
        date: je.journalDate,
        sourceRevenue: result.source.revenue,
        sourceTax: result.source.tax,
        sourceCost: result.source.cost,
        sourceCash: result.source.cash,
        journalRevenue: result.journal.revenue,
        journalTax: result.journal.tax,
        journalCost: result.journal.cost,
        journalCash: result.journal.cash,
        driftRevenue: result.drift.revenue,
        driftTax: result.drift.tax,
        driftCost: result.drift.cost,
        driftCash: result.drift.cash,
        balanced: result.balanced,
        warnings: result.warnings,
        journalEntryId: je.id,
        durationMs,
        createdBy: session.user?.email ?? null,
      },
    });

    logger.info(
      `Reconciled JE ${je.journalNumber} (id=${id}, date=${result.date}): ` +
        `balanced=${result.balanced}, drift={revenue:${result.drift.revenue}, tax:${result.drift.tax}, cost:${result.drift.cost}, cash:${result.drift.cash}}`,
    );

    res.status(200).json(result);
  } catch (err: unknown) {
    logError(`Reconciliation failed for JE ${id}`, err);
    const message = err instanceof Error ? err.message : "Reconciliation failed";
    res.status(500).json({ error: message });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  await handleReconcile(req, res, session, prisma);
});
