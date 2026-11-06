// /app/src/pages/api/automations/axper-traffic-sync.ts
//
// Daily cron endpoint for the Axper traffic-persistence flow. Called
// nightly by an external scheduler (curl + AUTO_IMPORT_API_KEY
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
import type { Session } from "next-auth";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { runAndStampTrafficLog, startTrafficSyncLog } from "@/lib/trafficSyncRun";
import { logError, logger } from "@/lib/logger";

async function run(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // The scheduler runs as "cron"; a human trigger is attributed to their email.
  const actor = session?.user?.email ?? "cron";

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

  let log;
  try {
    log = await startTrafficSyncLog(actor);
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

  void runAndStampTrafficLog(log.id, backfillWindowDays);
}

export default guardAutomation(run);
