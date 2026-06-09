// /app/src/pages/api/automations/axper-traffic-sync.ts
//
// Daily cron endpoint for the Axper traffic-persistence flow. Called
// at 02:00 ET by Synology Task Scheduler (curl + AUTO_IMPORT_API_KEY
// Bearer) and also exposed to the admin UI for "Run Now" via NextAuth
// session — same dual-auth pattern as `daily-reconciliation.ts`.
//
// Pulls yesterday from Axper, then auto-backfills any missing days
// in the last N (default 30) days. Writes one TrafficSyncLog row per
// invocation.
//
// Async by design (2026-05-28): the request creates a TrafficSyncLog
// row with `finishedAt = null` and returns 202 + logId IMMEDIATELY.
// The actual Axper fan-out runs in the background after the response
// is sent. The admin UI polls for the row's `finishedAt` to know
// when the work is done. The cron script (curl) doesn't care about
// the result body — it just looks at HTTP status.
//
// Why async: a 2-year backfill = ~730 Axper calls × ~1s each ≈ 12
// minutes, which is well past nginx's 300s upstream timeout (a 504
// rolled back the admin UI's first 2-year-backfill attempt). The
// cron's daily 30-day run is ~30s and fits inside the timeout
// either way, but unifying both code paths on async is simpler than
// dispatching by "expected duration."
//
// Crash recovery: if the Node process dies mid-job, the log row
// stays with `finishedAt = null` forever. The admin UI surfaces a
// "still running" indicator for those. A future janitor sweep —
// tracked as a spawned task — can mark rows with `startedAt > 1h
// ago AND finishedAt IS NULL` as abandoned.
//
// Origin: owner direction 2026-05-28.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { runTrafficImportWithBackfill } from "@/lib/runTrafficImport";
import { logError, logger } from "@/lib/logger";

function isAuthorized(
  req: NextApiRequest,
  session: { user?: { email?: string | null } } | null,
): { ok: boolean; actor: string } {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey) {
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${apiKey}`) {
      return { ok: true, actor: "cron" };
    }
  }
  if (session?.user?.email) {
    return { ok: true, actor: session.user.email };
  }
  return { ok: false, actor: "unauthenticated" };
}

/**
 * Run the backfill in the background and stamp the log row when done.
 * Fire-and-forget — never throws to the outer handler (the response
 * has already been sent). All failures land on the log row's
 * `errors` field so the admin UI can surface them.
 */
async function runAndStampLog(logId: number, backfillWindowDays: number): Promise<void> {
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  const auth = isAuthorized(req, session);
  if (!auth.ok) return res.status(401).json({ error: "Unauthorized" });

  // Cap at 800 days (~2 years + a buffer). Owner-driven: re-loads of
  // historical data from Axper are rare but valuable when seeding a
  // new report. Each in-window day = one Axper API call, so the
  // worst case (full 800-day backfill from cold) runs ~13 min and
  // the cron's per-day idempotent upsert keeps re-runs cheap.
  const body = (req.body || {}) as { backfillWindowDays?: number };
  const backfillWindowDays =
    Number.isFinite(body.backfillWindowDays) && (body.backfillWindowDays ?? 0) > 0
      ? Math.min(body.backfillWindowDays!, 800)
      : 30;

  // Create the log row UP FRONT so the client gets an id to poll
  // against immediately. `finishedAt = null` marks it as "running"
  // for the admin UI's indicator + the recent-runs table. `dayFrom`
  // / `dayTo` are placeholders for now (overwritten with the real
  // window when the job completes).
  const startedAt = new Date();
  let log;
  try {
    log = await prisma.trafficSyncLog.create({
      data: {
        startedAt,
        finishedAt: null,
        kind: "axper-traffic-sync",
        dayFrom: startedAt,
        dayTo: startedAt,
        triggeredBy: auth.actor,
      },
    });
  } catch (err) {
    logError("axper-traffic-sync: failed to create log row", err);
    return res.status(500).json({ error: "Failed to start traffic sync" });
  }

  // Kick off the work AFTER returning the response. `void` is
  // intentional: if we awaited here we'd be back to synchronous and
  // would 504 again on long backfills.
  res.status(202).json({
    logId: log.id,
    status: "running",
    backfillWindowDays,
  });

  void runAndStampLog(log.id, backfillWindowDays);
}
