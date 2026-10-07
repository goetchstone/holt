// /app/src/lib/upboard.ts
// Shared up-board utilities

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const SHIFT_MAX_HOURS = 9;

/**
 * Auto-expire shifts older than 9 hours.
 * Called on every board read to keep things clean without a cron job.
 */
export async function expireStaleShifts() {
  const cutoff = new Date(Date.now() - SHIFT_MAX_HOURS * 60 * 60 * 1000);

  // Find open shifts that started before the cutoff
  const staleShifts = await prisma.staffShift.findMany({
    where: {
      clockOut: null,
      clockIn: { lt: cutoff },
    },
  });

  if (staleShifts.length === 0) return;

  for (const shift of staleShifts) {
    // Close the shift
    await prisma.staffShift.update({
      where: { id: shift.id },
      data: { clockOut: new Date() },
    });

    // Remove from up-board
    await prisma.upBoardEntry.deleteMany({
      where: { staffMemberId: shift.staffMemberId },
    });
  }

  // Compact positions on affected boards
  const affectedStores = [...new Set(staleShifts.map((s) => s.storeLocation))];
  for (const store of affectedStores) {
    await compactAndPromote(store);
  }

  if (staleShifts.length > 0) {
    logger.warn(`Auto-expired ${staleShifts.length} shift(s) older than ${SHIFT_MAX_HOURS}h`);
  }
}

/**
 * Compact board positions (remove gaps) and ensure someone is UP.
 */
export async function compactAndPromote(storeLocation: string) {
  const entries = await prisma.upBoardEntry.findMany({
    where: { storeLocation },
    orderBy: { position: "asc" },
  });

  let hasUp = false;
  for (let i = 0; i < entries.length; i++) {
    const newPos = i + 1;
    const updates: any = {};

    if (entries[i].position !== newPos) {
      updates.position = newPos;
    }

    // First AVAILABLE person becomes UP if nobody is UP
    if (!hasUp && (entries[i].status === "UP" || entries[i].status === "AVAILABLE")) {
      if (entries[i].status !== "UP") {
        updates.status = "UP";
        updates.statusSince = new Date();
      }
      hasUp = true;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.upBoardEntry.update({
        where: { id: entries[i].id },
        data: updates,
      });
    }
  }
}
