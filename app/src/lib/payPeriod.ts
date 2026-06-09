// /app/src/lib/payPeriod.ts
//
// Bi-weekly pay-period math. Pure, no I/O — given a date (and a
// fixed anchor) it returns the 14-day pay period that contains it,
// plus prev/next navigation and a recent-periods list for the
// picker.
//
// Why an anchor: a "bi-weekly" cadence is ambiguous without a fixed
// reference point — you have to know which Monday a period starts on.
// PAY_PERIOD_ANCHOR is that reference. Every period boundary is
// anchor + 14·n days. The owner confirms the real anchor; until then
// the statement page also accepts custom start/end dates so a
// slightly-off anchor never blocks the report.
//
// All math is done on UTC calendar days so DST never shifts a
// boundary. A period is INCLUSIVE on both ends: [start 00:00, end]
// where end is the 13th day after start. Callers that query the DB
// use `endExclusive` (= start + 14 days) for `orderDate < endExclusive`.

/**
 * Fixed reference point for the bi-weekly cadence. MUST be the start
 * (first day) of a real pay period. Owner-confirmed 2026-05-29: a
 * real period ran 5/03/2026–5/16/2026, so the anchor is 2026-05-03
 * (a Sunday). Every period boundary is anchor + 14·n days. If the
 * cadence ever shifts, change this one line.
 */
export const PAY_PERIOD_ANCHOR_ISO = "2026-05-03"; // Sun — owner-confirmed period 5/03–5/16

const MS_PER_DAY = 86_400_000;
const PERIOD_DAYS = 14;

export interface PayPeriod {
  /** UTC midnight of the first day (inclusive). */
  start: Date;
  /** UTC midnight of the last day (inclusive). */
  end: Date;
  /** UTC midnight of the day AFTER the period — use for `orderDate < endExclusive` queries. */
  endExclusive: Date;
  /** Signed period index relative to the anchor (anchor period = 0). */
  index: number;
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function anchorDate(): Date {
  return new Date(`${PAY_PERIOD_ANCHOR_ISO}T00:00:00Z`);
}

function periodFromIndex(index: number): PayPeriod {
  const anchor = anchorDate().getTime();
  const start = new Date(anchor + index * PERIOD_DAYS * MS_PER_DAY);
  const endExclusive = new Date(start.getTime() + PERIOD_DAYS * MS_PER_DAY);
  const end = new Date(endExclusive.getTime() - MS_PER_DAY);
  return { start, end, endExclusive, index };
}

/**
 * The bi-weekly pay period containing `date`. Uses floor-division
 * relative to the anchor so dates before the anchor get negative
 * indices (still correct — the cadence extends backward).
 */
export function payPeriodForDate(date: Date): PayPeriod {
  const day = utcMidnight(date).getTime();
  const anchor = anchorDate().getTime();
  const index = Math.floor((day - anchor) / (PERIOD_DAYS * MS_PER_DAY));
  return periodFromIndex(index);
}

/** Shift a period by `delta` whole periods (negative = earlier). */
export function shiftPayPeriod(period: PayPeriod, delta: number): PayPeriod {
  return periodFromIndex(period.index + delta);
}

/**
 * The N most recent pay periods ending on or before `now`, newest
 * first. The period CONTAINING `now` is included as the first entry
 * (it's "in progress" but the operator still wants to see it).
 */
export function recentPayPeriods(now: Date, count: number): PayPeriod[] {
  const current = payPeriodForDate(now);
  const out: PayPeriod[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(shiftPayPeriod(current, -i));
  }
  return out;
}

/** Build a period from an explicit start date (snapped to UTC midnight). */
export function payPeriodFromStart(start: Date): PayPeriod {
  const startMid = utcMidnight(start);
  const endExclusive = new Date(startMid.getTime() + PERIOD_DAYS * MS_PER_DAY);
  const end = new Date(endExclusive.getTime() - MS_PER_DAY);
  const anchor = anchorDate().getTime();
  const index = Math.round((startMid.getTime() - anchor) / (PERIOD_DAYS * MS_PER_DAY));
  return { start: startMid, end, endExclusive, index };
}

/** "YYYY-MM-DD" for a period boundary (UTC). */
export function formatPeriodDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Human label, e.g. "May 18 – May 31, 2026". */
export function formatPeriodLabel(period: PayPeriod): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const startStr = period.start.toLocaleDateString("en-US", opts);
  const endStr = period.end.toLocaleDateString("en-US", {
    ...opts,
    year: "numeric",
  });
  return `${startStr} – ${endStr}`;
}
