// /app/src/lib/automations/runner.ts
//
// What wakes up and runs (GAP-37). The host's scheduler calls /api/automations/tick
// every 5 minutes, and that is all it knows: whether anything runs, and when, is the
// store's setting (owner, 2026-11-06: "Any automation should be something the user can
// configure").
//
// CLAIMING
//
// A job starts by moving lastStartedAt on from the value it read, which only one caller
// can do. So a second wake-up, or someone pressing Run now, can't run it twice. A long
// job doesn't hold up the rest: the next wake-up claims whatever's due and isn't running.
//
// A failure reaches someone (rule 65): the screen shows it, and it goes to ops alerts.

import { prisma } from "@/lib/prisma";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { logError } from "@/lib/logger";
import { reportOpsAlert } from "@/lib/opsAlert";
import { AUTOMATION_CATALOG, type AutomationKey } from "./catalog";
import { AUTOMATION_JOBS } from "./jobs";
import { isAutomationDue } from "./schedule";
import { getAutomationSettings, type AutomationRow, type AutomationStatus } from "./settings";

/** Past this a job that says RUNNING is taken to have died with its server. */
const ASSUME_DEAD_AFTER_MS = 2 * 60 * 60_000;
const SUMMARY_MAX = 500;

export interface AutomationRunResult {
  key: AutomationKey;
  status: AutomationStatus | "ALREADY_RUNNING";
  summary: string | null;
}

export function isStillRunning(
  row: Pick<AutomationRow, "lastStatus" | "lastStartedAt">,
  now: Date,
): boolean {
  return (
    row.lastStatus === "RUNNING" &&
    row.lastStartedAt !== null &&
    now.getTime() - row.lastStartedAt.getTime() < ASSUME_DEAD_AFTER_MS
  );
}

async function finish(
  key: AutomationKey,
  status: AutomationStatus,
  summary: string,
): Promise<AutomationRunResult> {
  const trimmed = summary.slice(0, SUMMARY_MAX);
  await prisma.automationSetting.update({
    where: { key },
    data: { lastStatus: status, lastSummary: trimmed, lastFinishedAt: new Date() },
  });
  return { key, status, summary: trimmed };
}

async function claimAndRun(row: AutomationRow, now: Date): Promise<AutomationRunResult> {
  const { key } = row;
  if (isStillRunning(row, now)) return { key, status: "ALREADY_RUNNING", summary: null };

  const claimed = await prisma.automationSetting.updateMany({
    where: { key, lastStartedAt: row.lastStartedAt },
    data: { lastStartedAt: now, lastStatus: "RUNNING", lastSummary: null, lastFinishedAt: null },
  });
  if (claimed.count === 0) return { key, status: "ALREADY_RUNNING", summary: null };

  const job = AUTOMATION_JOBS[key];
  let outcome: { ok: boolean; summary: string };
  try {
    const notReady = job.notReady ? await job.notReady() : null;
    if (notReady) return await finish(key, "SKIPPED", notReady);
    outcome = await job.run();
  } catch (err: unknown) {
    logError(`Automation failed: ${key}`, err);
    outcome = { ok: false, summary: err instanceof Error ? err.message : String(err) };
  }
  const result = await finish(key, outcome.ok ? "OK" : "FAILED", outcome.summary);
  if (!outcome.ok) {
    await reportOpsAlert({
      title: `Automation failed: ${AUTOMATION_CATALOG[key].name}`,
      detail: outcome.summary,
      context: { key },
    });
  }
  return result;
}

/** Run one now, whatever its setting says. That's Run now on the screen. */
export async function runAutomationNow(key: AutomationKey): Promise<AutomationRunResult> {
  const rows = await getAutomationSettings();
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`No setting for automation ${key}`);
  return claimAndRun(row, new Date());
}

/** Run everything switched on that's due, in the catalog's order. */
export async function runDueAutomations(now: Date = new Date()): Promise<AutomationRunResult[]> {
  await prisma.appSettings.updateMany({ data: { automationsWokenAt: now } });
  const [rows, timeZone] = await Promise.all([getAutomationSettings(), getBusinessTimeZone()]);
  const results: AutomationRunResult[] = [];
  for (const row of rows) {
    if (!row.isActive) continue;
    const { lastStartedAt, activeSince } = row;
    if (!isAutomationDue({ schedule: row, lastStartedAt, activeSince, now, timeZone })) continue;
    results.push(await claimAndRun(row, now));
  }
  return results;
}
