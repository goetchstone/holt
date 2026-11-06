// /app/src/lib/dailyReconciliationRun.ts
//
// One run of the daily reconciliation: one day (by default yesterday in the
// deployment's business timezone) or a date range, each writing one
// DailyReconciliationLog row. Re-runs append, so the operator has full history.
// Moved out of pages/api/automations/daily-reconciliation.ts so Admin > Automations
// and the route run the same thing (GAP-37, rule 14).

import { prisma } from "@/lib/prisma";
import { businessDayKey } from "@/lib/reports/businessDay";
import { getBusinessTimeZone } from "@/lib/appSettings";
import {
  computeDailyReconciliation,
  type DailyReconciliationResult,
} from "@/lib/dailyReconciliation";
import { logError } from "@/lib/logger";

export interface DateRange {
  start: Date;
  end: Date;
}

export interface ReconciliationSummary {
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

export function parseReconciliationRange(body: unknown): DateRange | null {
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
export async function runDailyReconciliation(options: {
  range?: DateRange | null;
  createdBy: string;
}): Promise<ReconciliationSummary> {
  const { createdBy } = options;
  let range: DateRange;
  if (options.range) {
    range = options.range;
  } else {
    const d = await defaultYesterday();
    range = { start: d, end: d };
  }

  const runId = `daily-recon-${Date.now()}`;

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

  return summary;
}
