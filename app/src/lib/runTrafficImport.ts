// /app/src/lib/runTrafficImport.ts
//
// Orchestrator for the persisted-traffic flow. Three entry points:
//
//   - runTrafficImportForDay(date)
//     Pull a single date from Axper, upsert every (intervalStart,
//     storeName) row into TrafficSnapshot. Idempotent — re-running
//     the same day updates existing rows in place.
//
//   - runTrafficImportWithBackfill({ primaryDate, backfillWindowDays })
//     The cron entrypoint. Pulls `primaryDate` (default: yesterday),
//     then scans the last N days for ANY day with zero rows in the
//     DB and pulls those too. Auto-self-heals when a previous cron
//     run missed.
//
//   - resolveAxperStoreLocation(axperStoreName, cache)
//     Map an Axper store name to a StoreLocation FK using the shared
//     `lib/storeColors.ts` mapping. Returns null when no mapping
//     exists; the import still persists the row with FK=null so the
//     operator can add the mapping + re-run.
//
// Origin: owner direction 2026-05-28 — "Persist daily + keep today
// live ... Auto-backfill from Axper."

import { prisma } from "@/lib/prisma";
import { fetchAxperTraffic, type AxperTrafficRow } from "@/lib/axperClient";
import { getStoreLocationName } from "@/lib/storeColors";
import { logError } from "@/lib/logger";

export interface TrafficImportResult {
  /** YYYY-MM-DD inclusive */
  dayFrom: string;
  /** YYYY-MM-DD inclusive */
  dayTo: string;
  rowsFetched: number;
  rowsInserted: number;
  rowsUpdated: number;
  /** Distinct calendar days scanned during a backfill pass. */
  daysScanned: number;
  /** Days where we found zero existing rows and pulled fresh data. */
  daysBackfilled: number;
  /** Axper store names that couldn't be mapped to a StoreLocation. */
  unmappedStores: string[];
  errors: string[];
}

function emptyResult(dayFrom: string, dayTo: string): TrafficImportResult {
  return {
    dayFrom,
    dayTo,
    rowsFetched: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    daysScanned: 0,
    daysBackfilled: 0,
    unmappedStores: [],
    errors: [],
  };
}

function formatYMD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Parse Axper's `local_time` field (ISO-ish, no TZ suffix) into a
 * Date. Stores are assumed to share one timezone (US Eastern by default); we treat the
 * value as local-clock and store it as-is so reports rendering in
 * the same TZ display the wall-clock the store actually saw.
 */
function parseLocalTime(s: string): Date | null {
  // Strip a trailing Z just in case, and append nothing — `new Date`
  // on a string without a TZ suffix interprets as LOCAL TIME, which
  // is what we want for store wall-clock.
  const cleaned = s.endsWith("Z") ? s.slice(0, -1) : s;
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function buildStoreLocationCache(): Promise<Map<string, number>> {
  const locations = await prisma.storeLocation.findMany({
    select: { id: true, name: true },
  });
  const byName = new Map<string, number>();
  for (const loc of locations) {
    byName.set(loc.name.toLowerCase(), loc.id);
  }
  return byName;
}

export function resolveAxperStoreLocation(
  axperStoreName: string,
  cache: Map<string, number>,
): number | null {
  // First map Axper name → StoreLocation.name via the shared mapping,
  // then look up the location FK from the cache.
  const targetName = getStoreLocationName(axperStoreName);
  return cache.get(targetName.toLowerCase()) ?? null;
}

interface UpsertOutcome {
  inserted: boolean;
  updated: boolean;
}

/**
 * Upsert one Axper row into TrafficSnapshot. Returns which side of
 * the create-or-update branch was taken so the caller can keep
 * counters. Extracted to keep `runTrafficImportForDay` below the
 * cognitive-complexity threshold (Sonar S3776).
 */
async function upsertOneTrafficRow(
  intervalStart: Date,
  row: AxperTrafficRow,
  storeLocationId: number | null,
): Promise<UpsertOutcome> {
  const data = {
    intervalStart,
    axperStoreName: row.store_name,
    storeLocationId,
    visitors: row.entries,
    exits: row.exits ?? null,
  };
  const existing = await prisma.trafficSnapshot.findUnique({
    where: {
      intervalStart_axperStoreName: {
        intervalStart,
        axperStoreName: row.store_name,
      },
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.trafficSnapshot.update({ where: { id: existing.id }, data });
    return { inserted: false, updated: true };
  }
  await prisma.trafficSnapshot.create({ data });
  return { inserted: true, updated: false };
}

/**
 * Fetch Axper rows for a single day. Returns `null` (and pushes an
 * error into `result`) on failure so the caller can short-circuit
 * without growing its own cognitive complexity.
 */
async function fetchRowsOrLog(
  ymd: string,
  result: TrafficImportResult,
): Promise<AxperTrafficRow[] | null> {
  try {
    return await fetchAxperTraffic({ dateFrom: ymd, dateTo: ymd });
  } catch (err) {
    result.errors.push(
      `Axper fetch for ${ymd} failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Process one Axper row: parse the local time, resolve the store FK,
 * upsert, and update counters. Errors are pushed into `result` and
 * `unmapped` is mutated for any unknown store name.
 */
async function processOneRow(
  row: AxperTrafficRow,
  cache: Map<string, number>,
  result: TrafficImportResult,
  unmapped: Set<string>,
): Promise<void> {
  const intervalStart = parseLocalTime(row.local_time);
  if (!intervalStart) {
    result.errors.push(`Skipped row with unparseable local_time: ${row.local_time}`);
    return;
  }
  const storeLocationId = resolveAxperStoreLocation(row.store_name, cache);
  if (storeLocationId === null) unmapped.add(row.store_name);

  try {
    const outcome = await upsertOneTrafficRow(intervalStart, row, storeLocationId);
    if (outcome.inserted) result.rowsInserted += 1;
    if (outcome.updated) result.rowsUpdated += 1;
  } catch (err) {
    result.errors.push(
      `Upsert failed for ${row.store_name} @ ${row.local_time}: ${err instanceof Error ? err.message : err}`,
    );
    logError("runTrafficImportForDay: upsert failed", err);
  }
}

/**
 * Pull a single date (or single-day range) from Axper and persist
 * every row. Returns counters so the caller can write to TrafficSyncLog.
 */
export async function runTrafficImportForDay(date: Date): Promise<TrafficImportResult> {
  const ymd = formatYMD(date);
  const result = emptyResult(ymd, ymd);
  result.daysScanned = 1;

  const cache = await buildStoreLocationCache();
  const rows = await fetchRowsOrLog(ymd, result);
  if (rows === null) return result;

  result.rowsFetched = rows.length;
  if (rows.length === 0) return result;

  const unmapped = new Set<string>();
  for (const row of rows) {
    await processOneRow(row, cache, result, unmapped);
  }

  result.unmappedStores = [...unmapped];
  return result;
}

export interface BackfillOptions {
  /**
   * The day the cron is "primarily" pulling. Default: yesterday in UTC.
   * (The cron runs at 02:00 ET so by then yesterday's data is final.)
   */
  primaryDate?: Date;
  /** Scan the last N days. Default 30. */
  backfillWindowDays?: number;
}

/**
 * Cron entry point. Pulls the primary date, then scans the last N
 * days for any day with zero snapshots in the DB and pulls those too.
 */
export async function runTrafficImportWithBackfill(
  opts: BackfillOptions = {},
): Promise<TrafficImportResult> {
  const today = startOfDayUTC(new Date());
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const primaryDate = opts.primaryDate ?? yesterday;
  const backfillWindowDays = opts.backfillWindowDays ?? 30;

  const result = emptyResult(formatYMD(primaryDate), formatYMD(primaryDate));

  // Step 1: primary day.
  const primary = await runTrafficImportForDay(primaryDate);
  mergeResult(result, primary);

  // Step 2: scan the last N days for gaps.
  const windowEnd = new Date(primaryDate);
  const windowStart = new Date(primaryDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - (backfillWindowDays - 1));

  // Get every day in the window that has ANY snapshot row already.
  // The days NOT in this set are the gaps we'll backfill.
  const existingDays = await prisma.$queryRaw<Array<{ day: string }>>`
    SELECT DISTINCT TO_CHAR("intervalStart", 'YYYY-MM-DD') AS day
    FROM "TrafficSnapshot"
    WHERE "intervalStart" >= ${windowStart}
      AND "intervalStart" < ${new Date(windowEnd.getTime() + 86_400_000)}
  `;
  const seenDays = new Set(existingDays.map((r) => r.day));

  // Walk every day in the window. Skip days that already have rows
  // OR that we just imported as the primary.
  const cursor = new Date(windowStart);
  while (cursor.getTime() <= windowEnd.getTime()) {
    const ymd = formatYMD(cursor);
    result.daysScanned += 1;
    if (ymd !== formatYMD(primaryDate) && !seenDays.has(ymd)) {
      const day = new Date(cursor);
      const backfilled = await runTrafficImportForDay(day);
      mergeResult(result, backfilled);
      result.daysBackfilled += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  result.dayFrom = formatYMD(windowStart);
  result.dayTo = formatYMD(windowEnd);
  return result;
}

function mergeResult(into: TrafficImportResult, from: TrafficImportResult): void {
  into.rowsFetched += from.rowsFetched;
  into.rowsInserted += from.rowsInserted;
  into.rowsUpdated += from.rowsUpdated;
  // dayScanned is incremented in the caller (one per loop iteration);
  // do not add `from.daysScanned` here.
  // daysBackfilled is incremented in the caller.
  into.unmappedStores = [...new Set([...into.unmappedStores, ...from.unmappedStores])];
  into.errors = [...into.errors, ...from.errors];
}
