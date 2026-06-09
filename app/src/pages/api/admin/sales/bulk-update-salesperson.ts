// /app/src/pages/api/admin/sales/bulk-update-salesperson.ts
//
// Bulk update salesperson assignments on multiple orders at once.
// Manager-only. All changes are logged to OrderChangeLog.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { loadActiveConfirmations } from "@/lib/payPeriodLockGuard";
import { isAttributionLocked } from "@/lib/payPeriodLock";

export const config = { api: { bodyParser: { sizeLimit: "5mb" } } };

interface UpdateRow {
  orderId: number;
  salesPersonId: number | null;
  splitWithId?: number | null;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const updates = req.body.updates as UpdateRow[] | undefined;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "updates array is required" });
    }

    // Pre-load staff for name resolution
    const allStaff = await prisma.staffMember.findMany({
      select: { id: true, displayName: true },
    });
    const staffById = new Map(allStaff.map((s) => [s.id, s.displayName]));

    // Pay-period lock — load once; skip+error any row whose order
    // date sits in a confirmed period for the current or target
    // designer. Per-row (not whole-batch) so one locked order doesn't
    // sink the rest.
    const activeConfirmations = await loadActiveConfirmations();

    let updated = 0;
    const errors: { orderId: number; reason: string }[] = [];

    // Process in batches
    const BATCH_SIZE = 50;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);

      await prisma.$transaction(async (tx) => {
        for (const row of batch) {
          const order = await tx.salesOrder.findUnique({
            where: { id: row.orderId },
            select: {
              id: true,
              orderDate: true,
              salesperson: true,
              salesPersonId: true,
              splitWithId: true,
            },
          });

          if (!order) {
            errors.push({ orderId: row.orderId, reason: "Order not found" });
            continue;
          }

          // Pay-period lock guard.
          const resolvedSplitForLock = row.splitWithId ?? null;
          if (
            isAttributionLocked(
              order.orderDate,
              [order.salesPersonId, order.splitWithId, row.salesPersonId, resolvedSplitForLock],
              activeConfirmations,
            )
          ) {
            errors.push({
              orderId: row.orderId,
              reason: "Pay period confirmed/locked — reopen the period to reassign",
            });
            continue;
          }

          // Validate salesperson
          if (row.salesPersonId !== null && !staffById.has(row.salesPersonId)) {
            errors.push({ orderId: row.orderId, reason: "Salesperson not found" });
            continue;
          }

          const resolvedSplit = row.splitWithId ?? null;
          if (resolvedSplit !== null && !staffById.has(resolvedSplit)) {
            errors.push({ orderId: row.orderId, reason: "Split salesperson not found" });
            continue;
          }

          if (row.salesPersonId !== null && row.salesPersonId === resolvedSplit) {
            errors.push({ orderId: row.orderId, reason: "Primary and split are the same" });
            continue;
          }

          // Skip if nothing changed
          if (order.salesPersonId === row.salesPersonId && order.splitWithId === resolvedSplit) {
            continue;
          }

          const newName = row.salesPersonId !== null ? staffById.get(row.salesPersonId) : null;

          await tx.salesOrder.update({
            where: { id: row.orderId },
            data: {
              salesPersonId: row.salesPersonId,
              salesperson: newName ?? order.salesperson,
              splitWithId: resolvedSplit,
              updatedBy: session.user!.email,
            },
          });

          await tx.orderChangeLog.create({
            data: {
              salesOrderId: row.orderId,
              changeType: "SALESPERSON_CHANGE",
              previousValue: [
                order.salesperson || "none",
                order.splitWithId
                  ? `split with ${staffById.get(order.splitWithId) || `#${order.splitWithId}`}`
                  : null,
              ]
                .filter(Boolean)
                .join(", "),
              newValue: [
                newName || order.salesperson || "none",
                resolvedSplit
                  ? `split with ${staffById.get(resolvedSplit) || `#${resolvedSplit}`}`
                  : null,
              ]
                .filter(Boolean)
                .join(", "),
              changedBy: session.user!.email,
              reason: "Bulk salesperson correction",
            },
          });

          updated++;
        }
      }, TX_TIMEOUT.LONG);
    }

    logger.info("Bulk salesperson update completed", {
      updated,
      errorCount: errors.length,
      user: session.user?.email ?? "unknown",
    });

    return res.status(200).json({ updated, errors });
  },
);
