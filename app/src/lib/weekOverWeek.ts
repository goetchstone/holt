// /app/src/lib/weekOverWeek.ts
//
// Week-over-week date math for the Weekly Summary report. Pure, UTC,
// no I/O. Weeks run Sunday→Saturday (retail convention). "Same week
// last year" is 52 weeks (364 days) back, NOT the same calendar date:
// 364 days keeps the weekday aligned (Sun→Sun), so weekend counts
// match and weekday-defined holidays (Memorial Day, Labor Day,
// Thanksgiving) land in the same relative week. That's the holiday
// alignment the owner asked for, without needing a fixed fiscal
// calendar. All math is on UTC calendar days so DST never shifts a
// boundary.

const MS_PER_DAY = 86_400_000;
const WEEK_DAYS = 7;
const YEAR_BACK_DAYS = 364; // 52 weeks — preserves day-of-week alignment

/** UTC midnight (00:00Z) of `date`'s calendar day. */
function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The Sunday (UTC midnight) on or before `date`. */
export function startOfRetailWeek(date: Date): Date {
  const day = utcMidnight(date);
  const dow = day.getUTCDay(); // 0 = Sunday … 6 = Saturday
  return new Date(day.getTime() - dow * MS_PER_DAY);
}

/**
 * The Sunday that began the most recent COMPLETE week before `now` —
 * i.e. the week before the one containing `now`. This is the report's
 * default ("start of last week").
 */
export function lastCompleteWeekStart(now: Date): Date {
  return new Date(startOfRetailWeek(now).getTime() - WEEK_DAYS * MS_PER_DAY);
}

/** Inclusive Saturday end (UTC midnight) of the week starting `weekStart`. */
export function weekEnd(weekStart: Date): Date {
  return new Date(weekStart.getTime() + (WEEK_DAYS - 1) * MS_PER_DAY);
}

/** Exclusive end (the next Sunday) — use for `date < weekEndExclusive` queries. */
export function weekEndExclusive(weekStart: Date): Date {
  return new Date(weekStart.getTime() + WEEK_DAYS * MS_PER_DAY);
}

/** Same week one year back: 52 weeks (364 days) earlier, weekday-aligned. */
export function sameWeekLastYear(weekStart: Date): Date {
  return new Date(weekStart.getTime() - YEAR_BACK_DAYS * MS_PER_DAY);
}

/** "May 17 – May 23, 2026" for the week starting `weekStart` (UTC). */
export function formatWeekRange(weekStart: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const startStr = weekStart.toLocaleDateString("en-US", opts);
  const endStr = weekEnd(weekStart).toLocaleDateString("en-US", { ...opts, year: "numeric" });
  return `${startStr} – ${endStr}`;
}

/** "YYYY-MM-DD" (UTC) for a week boundary. */
export function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
