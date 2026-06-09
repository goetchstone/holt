// /app/src/lib/axperClient.ts
//
// Thin client around Axper's TrafficReport API. One module, one
// responsibility — fetch raw rows for a single day or a date range.
// Parsing the rows + persisting them is the import runner's job;
// live-render UIs + reports use this client directly when they need
// today's bytes before the next cron run.
//
// Origin: extracted from `pages/api/axper/traffic/index.ts` as part
// of the persistence work 2026-05-28. The existing endpoint stays
// in place (still used by the dashboard charts) and imports from
// here so the credential + URL live in one spot.
//
// Multi-day calls walk the range day-by-day INTERNALLY. Owner-
// verified pattern (2026-05-28): Axper's
// `GetTrafficDataUsingDailyPeriod` returns the correct counts only
// when DateFrom === DateTo. Passing a wider range silently changes
// the aggregation shape and counts come back wrong. This safety net
// lives in the client so EVERY caller — the cron, the on-demand
// dashboard widget, any future report — gets the right behavior
// without having to remember.

import axios from "axios";
import { logError } from "@/lib/logger";
import { resolveCredential } from "@/lib/integrationCredentials";

/**
 * Shape of one row Axper returns. The JSON response is an array of
 * these (or a CSV that starts with the same header line, used as a
 * fallback when their JSON encoder hiccups).
 */
export interface AxperTrafficRow {
  store_number: string;
  store_name: string;
  /** Local-clock ISO string (no timezone suffix; treat as the store's local time). */
  local_time: string;
  /** Visitors who came in during this 15-min interval. */
  entries: number;
  /** Visitors who left during this 15-min interval. */
  exits: number;
}

const AXPER_URL = "https://cloud.axper.com/api/TrafficReport/GetTrafficDataUsingDailyPeriod";

/**
 * Hard cap on how many days a single `fetchAxperTraffic` call will
 * walk. The persistence runner (`runTrafficImportWithBackfill`) does
 * its own per-day looping with its own counters and DB writes, so it
 * never relies on this client to span days. This cap is for ad-hoc
 * callers (e.g. a future report) and bounds the worst-case fan-out.
 */
const MAX_RANGE_DAYS = 800;

/** Hours per day -> ms. Used for date math + range enumeration. */
const MS_PER_DAY = 86_400_000;

interface FetchOpts {
  /** YYYY-MM-DD inclusive */
  dateFrom: string;
  /** YYYY-MM-DD inclusive */
  dateTo: string;
  /** Defaults to 15 (Axper's per-15-min granularity). */
  intervalInMinutes?: number;
  /** Defaults to "09:00" (store-open). */
  hourMinuteFrom?: string;
  /** Defaults to "18:00" (store-close). */
  hourMinuteTo?: string;
}

/**
 * Enumerate every YYYY-MM-DD in `[dateFrom, dateTo]` inclusive,
 * walking by calendar day in UTC. Returns `null` if either input is
 * unparseable, dateFrom > dateTo, or the range exceeds `MAX_RANGE_DAYS`.
 *
 * Exported for testing the range math without going through the
 * network path.
 */
export function enumerateAxperDays(dateFrom: string, dateTo: string): string[] | null {
  const fromTs = Date.parse(`${dateFrom}T00:00:00Z`);
  const toTs = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return null;
  if (toTs < fromTs) return null;

  const dayCount = Math.round((toTs - fromTs) / MS_PER_DAY) + 1;
  if (dayCount > MAX_RANGE_DAYS) return null;

  const days: string[] = [];
  for (let i = 0; i < dayCount; i += 1) {
    days.push(formatYmdUtc(new Date(fromTs + i * MS_PER_DAY)));
  }
  return days;
}

function formatYmdUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Issue exactly one Axper call for a single calendar day. All the
 * defensive "Axper sometimes returns CSV / non-array / missing
 * fields" handling lives here so the caller (single-day or
 * multi-day-loop) always gets back a clean row array.
 */
async function fetchOneDay(
  apiKey: string,
  ymd: string,
  opts: FetchOpts,
): Promise<AxperTrafficRow[]> {
  const params = {
    ApiKey: apiKey,
    DateFrom: ymd,
    DateTo: ymd,
    IntervalInMinutes: opts.intervalInMinutes ?? 15,
    HourMinuteFrom: opts.hourMinuteFrom ?? "09:00",
    HourMinuteTo: opts.hourMinuteTo ?? "18:00",
    FileFormat: "json",
  };

  try {
    const response = await axios.get(AXPER_URL, { params, timeout: 30_000 });

    // Axper occasionally returns the CSV body even when FileFormat=json.
    // The CSV starts with the header row; treat it as "no data" — the
    // caller can retry on the next cron tick.
    if (typeof response.data === "string" && response.data.startsWith("store_number,store_name")) {
      return [];
    }

    if (!Array.isArray(response.data)) {
      return [];
    }
    // Defensive: skip rows missing required fields.
    return response.data.filter(
      (r): r is AxperTrafficRow =>
        r != null &&
        typeof r.store_name === "string" &&
        typeof r.local_time === "string" &&
        typeof r.entries === "number",
    );
  } catch (err) {
    logError(`axperClient: fetchOneDay(${ymd}) failed`, err);
    return [];
  }
}

/**
 * Fetch traffic rows for a single date OR a range of dates from Axper.
 * Multi-day ranges walk day-by-day INTERNALLY (one Axper call per day,
 * concatenated) because Axper's `GetTrafficDataUsingDailyPeriod`
 * returns wrong counts on multi-day calls.
 *
 * Returns an empty array (NOT throwing) on:
 *   - Missing AXPER_API_KEY env var
 *   - Unparseable / inverted / over-cap date range
 *   - Per-day network / HTTP failure (only the failed day's rows are
 *     dropped; other days in the range still return their data)
 *   - CSV fallback path (Axper occasionally returns CSV instead of
 *     JSON; we don't parse it here — the caller can re-try later)
 *
 * The defensive empty-array shape mirrors the existing on-demand
 * endpoint behavior and keeps the daily cron resilient to upstream
 * outages: missing days surface in the admin "gaps" view rather than
 * crashing the cron.
 */
export async function fetchAxperTraffic(opts: FetchOpts): Promise<AxperTrafficRow[]> {
  const apiKey = await resolveCredential("axper", "apiKey", "AXPER_API_KEY");
  if (!apiKey) {
    logError(
      "axperClient: Axper API key not set (Settings > Integrations or AXPER_API_KEY) — returning empty traffic array",
      new Error("missing AXPER_API_KEY"),
    );
    return [];
  }

  const days = enumerateAxperDays(opts.dateFrom, opts.dateTo);
  if (days === null) {
    logError(
      `axperClient: invalid or oversized date range (dateFrom=${opts.dateFrom}, dateTo=${opts.dateTo}, max=${MAX_RANGE_DAYS})`,
      new Error("invalid_axper_range"),
    );
    return [];
  }

  if (days.length === 1) {
    return fetchOneDay(apiKey, days[0], opts);
  }

  // Multi-day: walk day-by-day, concatenate, never spread a single
  // multi-day Axper call. Sequential (not Promise.all) to be polite
  // to Axper and to keep the order deterministic for downstream
  // sorting + de-dup.
  const out: AxperTrafficRow[] = [];
  for (const ymd of days) {
    const rows = await fetchOneDay(apiKey, ymd, opts);
    if (rows.length > 0) out.push(...rows);
  }
  return out;
}
