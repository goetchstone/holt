// /app/src/pages/api/inventory/snapshot/generate.ts
//
// Step 1 of a physical count, sourced from holt's own data. Replaces "upload
// a POS on-hand export" as the normal path -- see InventorySnapshot's schema
// comment (prisma/schema.prisma) for why that path was wrong: it was keyed on
// the POS's product id, so every product created natively in holt was
// silently absent from its own count. The POS import
// (src/pages/api/import/inventory-snapshot.ts) still exists, demoted to a
// cutover/parallel-run tool.
//
// Shares its aggregation with InventoryFreeze via src/lib/inventory/snapshot.ts
// so the two can never drift on what "current inventory" means.
//
// snapshotDate is truncated to the start of today rather than a raw
// millisecond timestamp. That makes "the same snapshotDate" a stable target
// across repeat calls on the same day, so a re-run (e.g. after fixing a
// product's department mapping) clears and replaces today's LOCAL rows
// instead of tripping the (snapshotDate, productId, storeLocationId) unique
// constraint or leaving stale and fresh rows mixed together.

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { aggregateCurrentInventory, summarizeInventoryAggregate } from "@/lib/inventory/snapshot";
import { logger, logError } from "@/lib/logger";
import { auditLog } from "@/lib/audit";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  return requirePermission("inventory.adjust", handlePost)(req, res);
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Pure(ish) handler body, exported for integration testing (mirrors the
 * pattern in pages/api/tills/[id]/close.ts). Auth happens in the default
 * export above; this function trusts its caller for that.
 */
export async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const snapshotDate = startOfToday();
  const createdBy = session.user?.email || undefined;

  try {
    const summary = await prisma.$transaction(async (tx) => {
      const rows = await aggregateCurrentInventory(tx);

      // Idempotent re-run: clear today's LOCAL rows before writing the fresh
      // set, rather than crashing on the unique constraint. IMPORT rows
      // (cutover/parallel-run data) are untouched -- this endpoint only ever
      // owns LOCAL rows.
      await tx.inventorySnapshot.deleteMany({
        where: { snapshotDate, source: "LOCAL" },
      });

      if (rows.length > 0) {
        await tx.inventorySnapshot.createMany({
          data: rows.map((row) => ({
            productId: row.productId,
            storeLocationId: row.storeLocationId,
            quantity: row.quantity,
            snapshotDate,
            source: "LOCAL",
            createdBy,
          })),
        });
      }

      return summarizeInventoryAggregate(rows);
    }, TX_TIMEOUT.LONG);

    logger.info("Generated local inventory snapshot", {
      ...summary,
      snapshotDate: snapshotDate.toISOString(),
      createdBy,
    });
    // This resets the baseline a whole physical count is judged against --
    // belongs in the audit stream same as the bulk-mutation imports.
    auditLog("INVENTORY_SNAPSHOT_GENERATE", createdBy || "unknown", {
      ...summary,
      snapshotDate: snapshotDate.toISOString(),
    });

    return res.status(201).json({
      snapshotDate,
      products: summary.productCount,
      units: summary.totalUnits,
      stores: summary.storeLocationCount,
    });
  } catch (error) {
    logError("Failed to generate local inventory snapshot", error);
    return res.status(500).json({ error: "Failed to generate inventory snapshot." });
  }
}
