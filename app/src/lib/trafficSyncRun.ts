// /app/src/lib/trafficSyncRun.ts
//
// One run of the door counter sync: a TrafficSyncLog row made up front, then the
// backfill, then the row stamped with what happened. The route answers as soon as the
// row exists and leaves the work running, since a long backfill would time out.
// Admin > Automations waits for it, since it runs off to one side anyway (GAP-37).

import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";
import { runTrafficImportWithBackfill } from "@/lib/runTrafficImport";

/**
 * Make the log row up front, so a caller has an id to poll straight away.
 * `finishedAt = null` marks it as running. `dayFrom` and `dayTo` are placeholders,
 * overwritten with the real window when the job completes.
 */
export function startTrafficSyncLog(actor: string) {
  const startedAt = new Date();
  return prisma.trafficSyncLog.create({
    data: {
      startedAt,
      finishedAt: null,
      kind: "axper-traffic-sync",
      dayFrom: startedAt,
      dayTo: startedAt,
      triggeredBy: actor,
    },
  });
}

/**
 * Run the backfill and stamp the log row when done. Never throws: the route has
 * already answered by then. All failures land on the log row's `errors` field, so
 * the admin UI can surface them.
 */
export async function runAndStampTrafficLog(
  logId: number,
  backfillWindowDays: number,
): Promise<void> {
  try {
    const result = await runTrafficImportWithBackfill({ backfillWindowDays });
    await prisma.trafficSyncLog.update({
      where: { id: logId },
      data: {
        finishedAt: new Date(),
        dayFrom: new Date(result.dayFrom),
        dayTo: new Date(result.dayTo),
        rowsFetched: result.rowsFetched,
        rowsInserted: result.rowsInserted,
        rowsUpdated: result.rowsUpdated,
        daysScanned: result.daysScanned,
        daysBackfilled: result.daysBackfilled,
        errors: result.errors,
      },
    });
    logger.info(
      `axper-traffic-sync: logId=${logId} done (fetched=${result.rowsFetched}, inserted=${result.rowsInserted}, updated=${result.rowsUpdated}, days=${result.daysScanned})`,
    );
  } catch (err) {
    logError(`axper-traffic-sync: logId=${logId} failed`, err);
    try {
      await prisma.trafficSyncLog.update({
        where: { id: logId },
        data: {
          finishedAt: new Date(),
          errors: [err instanceof Error ? err.message : String(err)],
        },
      });
    } catch (stampErr) {
      // Last-resort: even the error-stamp failed. Log + give up.
      logError(`axper-traffic-sync: logId=${logId} could not stamp error`, stampErr);
    }
  }
}
