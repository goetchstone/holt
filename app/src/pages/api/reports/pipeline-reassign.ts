// /app/src/pages/api/reports/pipeline-reassign.ts
//
// Bulk-reassign open quotes and orders from one salesperson to another.
// Updates both the legacy salesperson string and the salesPersonId FK.
// MANAGER/ADMIN only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { loadActiveConfirmations } from "@/lib/payPeriodLockGuard";
import { isAttributionLocked } from "@/lib/payPeriodLock";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end();
    }

    const { fromSalesperson, toStaffId } = req.body;

    if (!fromSalesperson || !toStaffId) {
      return res.status(400).json({ error: "fromSalesperson and toStaffId are required" });
    }

    try {
      const target = await prisma.staffMember.findUnique({
        where: { id: Number(toStaffId) },
        select: { id: true, displayName: true, isActive: true },
      });

      if (!target) return res.status(404).json({ error: "Target staff member not found" });
      if (!target.isActive)
        return res.status(400).json({ error: "Target staff member is not active" });

      // Pay-period lock: exclude any matched order whose date sits in
      // a confirmed period (for its current designer or the target).
      // Reassigning open quotes/orders is normally a current-period
      // action, but an ORDER dated in a locked past period could
      // match — skip those + report the count rather than silently
      // breaking a locked period.
      const activeConfirmations = await loadActiveConfirmations();
      const candidates = await prisma.salesOrder.findMany({
        where: { salesperson: fromSalesperson, status: { in: ["QUOTE", "ORDER"] } },
        select: { id: true, orderDate: true, salesPersonId: true, splitWithId: true },
      });
      const unlockedIds: number[] = [];
      let skippedLocked = 0;
      for (const o of candidates) {
        if (
          isAttributionLocked(
            o.orderDate,
            [o.salesPersonId, o.splitWithId, target.id],
            activeConfirmations,
          )
        ) {
          skippedLocked += 1;
        } else {
          unlockedIds.push(o.id);
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.salesOrder.updateMany({
          where: { id: { in: unlockedIds } },
          data: {
            salesperson: target.displayName,
            salesPersonId: target.id,
            updatedBy: session.user?.email ?? null,
          },
        });

        return { reassigned: updated.count, toSalesperson: target.displayName, skippedLocked };
      }, TX_TIMEOUT.SHORT);

      logger.info("Reassigned pipeline", {
        from: fromSalesperson,
        to: result.toSalesperson,
        count: result.reassigned,
        skippedLocked: result.skippedLocked,
        by: session.user?.email,
      });

      return res.status(200).json(result);
    } catch (err: unknown) {
      logError("Failed to reassign pipeline", err);
      return res.status(500).json({ error: "Failed to reassign pipeline" });
    }
  },
);
