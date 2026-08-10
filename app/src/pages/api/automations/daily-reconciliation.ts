// /app/src/pages/api/automations/daily-reconciliation.ts
//
// Phase 0 C1 — daily-reconciliation cron endpoint. Called by the Synology
// Task Scheduler (via curl + AUTO_IMPORT_API_KEY Bearer) at end-of-day,
// or manually from the admin UI (via NextAuth session).
//
// Wraps `computeDailyReconciliation` from lib/dailyReconciliation.ts.
// One run can reconcile one day (default: yesterday in America/New_York)
// or a date range. Each reconciled day produces exactly one
// DailyReconciliationLog row — re-runs append, don't overwrite, so the
// operator has full history.
//
// Dual auth model: Bearer (AUTO_IMPORT_API_KEY) for unattended cron runs,
// NextAuth session for the admin UI. No role gating beyond authentication
// itself — reading reconciliation results is non-destructive.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { businessDayKey } from "@/lib/reports/businessDay";
import { getBusinessTimeZone } from "@/lib/appSettings";
import {
  computeDailyReconciliation,
  type DailyReconciliationResult,
} from "@/lib/dailyReconciliation";
import { logError } from "@/lib/logger";

interface DateRange {
  start: Date;
  end: Date;
}

interface ReconciliationSummary {
  runId: string;
  daysReconciled: number;
  daysBalanced: number;
  daysWithDrift: number;
  daysWithError: number;
  results: Array<{
    date: string;
    status: "BALANCED" | "DRIFT" | "ERROR";
    drift: { revenue: number; tax: number; cost: number; cash: number };
    /** Over/Short plug the day's JE needed to balance. Reported alongside
     * drift, never inside it — a plug has no source-side counterpart. */
    overShort: number;
    warnings: string[];
    journalEntryId: number | null;
    logId: number;
  }>;
  errors: string[];
}

function isAuthorized(
  req: NextApiRequest,
  session: { user?: { email?: string | null } } | null,
): boolean {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey) {
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${apiKey}`) return true;
  }
  if (session?.user?.email) return true;
  return false;
}

/**
 * Default date when nothing is passed: yesterday in the DEPLOYMENT'S business
 * timezone. Matches the "Prior_Day" semantics of the POS import reports — the
 * cron fires after local midnight and reconciles the day that just closed.
 *
 * This used to hardcode "America/New_York". It was the only money path that
 * got the timezone right, which is precisely the problem: lib/reports/
 * salesDaily.ts read its dates off the UTC calendar, so the two could not tie
 * out for any store trading past 7-8pm. Both now read AppSettings.timezone
 * through the same helper, so they agree by construction rather than by
 * coincidence.
 */
async function defaultYesterday(): Promise<Date> {
  const timeZone = await getBusinessTimeZone();
  const todayKey = businessDayKey(new Date(), timeZone);
  const [y, m, d] = todayKey.split("-").map(Number);
  // One day back on the calendar, then re-resolved to that business day's
  // start. Stepping the calendar rather than subtracting 24h keeps a DST
  // boundary from landing on the wrong day.
  const yesterdayKey = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  // A DATE MARKER, matching what parseRange() and enumerateDays() produce.
  //
  // This used to return businessDayStart(yesterdayKey, timeZone) -- the INSTANT
  // the business day opened. That made this the only caller handing
  // computeDailyReconciliation something other than a marker, and for any
  // timezone east of UTC the anchor falls on the PREVIOUS UTC date, so both the
  // reconciliation and its log row landed a day early. The timezone still
  // decides WHICH date is "yesterday" (businessDayKey above); it does not
  // belong in the marker itself.
  return new Date(`${yesterdayKey}T00:00:00.000Z`);
}

function parseRange(body: unknown): DateRange | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Single date: { date: "YYYY-MM-DD" }
  if (typeof b.date === "string") {
    const d = new Date(`${b.date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return { start: d, end: d };
  }

  // Range: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
  if (typeof b.start === "string" && typeof b.end === "string") {
    const start = new Date(`${b.start}T00:00:00Z`);
    const end = new Date(`${b.end}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (end.getTime() < start.getTime()) return null;
    return { start, end };
  }

  return null;
}

function enumerateDays(range: DateRange): Date[] {
  const days: Date[] = [];
  const cursor = new Date(range.start);
  while (cursor.getTime() <= range.end.getTime()) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function resultStatus(r: DailyReconciliationResult): "BALANCED" | "DRIFT" {
  return r.balanced ? "BALANCED" : "DRIFT";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!isAuthorized(req, session)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const explicitRange = parseRange(req.body);
  let range: DateRange;
  if (explicitRange) {
    range = explicitRange;
  } else {
    const d = await defaultYesterday();
    range = { start: d, end: d };
  }

  const runId = `daily-recon-${Date.now()}`;
  const createdBy = session?.user?.email || "auto-import";

  const summary: ReconciliationSummary = {
    runId,
    daysReconciled: 0,
    daysBalanced: 0,
    daysWithDrift: 0,
    daysWithError: 0,
    results: [],
    errors: [],
  };

  const timeZone = await getBusinessTimeZone();

  try {
    for (const day of enumerateDays(range)) {
      const startedAt = new Date();
      const dateIso = day.toISOString().slice(0, 10);

      try {
        const result = await computeDailyReconciliation({ date: day, timeZone, client: prisma });
        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - startedAt.getTime();

        const log = await prisma.dailyReconciliationLog.create({
          data: {
            date: day,
            sourceRevenue: result.source.revenue,
            sourceTax: result.source.tax,
            sourceCost: result.source.cost,
            sourceCash: result.source.cash,
            journalRevenue: result.journal.revenue,
            journalTax: result.journal.tax,
            journalCost: result.journal.cost,
            journalCash: result.journal.cash,
            journalOverShort: result.journal.overShort,
            driftRevenue: result.drift.revenue,
            driftTax: result.drift.tax,
            driftCost: result.drift.cost,
            driftCash: result.drift.cash,
            balanced: result.balanced,
            warnings: result.warnings,
            journalEntryId: result.journalEntryId,
            durationMs,
            createdBy,
          },
        });

        const status = resultStatus(result);
        summary.daysReconciled++;
        if (status === "BALANCED") summary.daysBalanced++;
        else summary.daysWithDrift++;

        summary.results.push({
          date: dateIso,
          status,
          drift: result.drift,
          overShort: result.journal.overShort,
          warnings: result.warnings,
          journalEntryId: result.journalEntryId,
          logId: log.id,
        });
      } catch (dayErr: unknown) {
        const msg = dayErr instanceof Error ? dayErr.message : String(dayErr);
        logError(`Daily reconciliation failed for ${dateIso}`, dayErr);

        // Still write a log entry on error so the operator sees "we tried"
        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - startedAt.getTime();
        const errorLog = await prisma.dailyReconciliationLog.create({
          data: {
            date: day,
            balanced: false,
            warnings: [`ERROR: ${msg}`],
            durationMs,
            createdBy,
          },
        });

        summary.daysReconciled++;
        summary.daysWithError++;
        summary.results.push({
          date: dateIso,
          status: "ERROR",
          drift: { revenue: 0, tax: 0, cost: 0, cash: 0 },
          overShort: 0,
          warnings: [`ERROR: ${msg}`],
          journalEntryId: null,
          logId: errorLog.id,
        });
        summary.errors.push(`${dateIso}: ${msg}`);
      }
    }

    return res.status(200).json(summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("Daily reconciliation orchestrator failed", err);
    return res.status(500).json({ error: "Daily reconciliation failed", details: msg });
  }
}
