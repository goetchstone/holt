// /app/src/lib/reports/businessDay.ts
//
// What day does a sale belong to?
//
// The database stores an instant, not a date. `SalesOrder.orderDate` is a
// `DateTime` and the POS writes `orderDate: now` (lib/paymentService.ts), so a
// sofa rung at 8:00pm Eastern is stored as 00:00Z the NEXT day. Read the
// calendar date straight off that instant -- which is what
// `orderDate.toISOString().slice(0, 10)` does -- and the sofa is reported on
// tomorrow.
//
//   sold 2026-08-08 14:00 Eastern -> stored 18:00Z 08-08 -> reported 08-08  ok
//   sold 2026-08-08 20:00 Eastern -> stored 00:00Z 08-09 -> reported 08-09  WRONG
//
// The date is the date -- to a person standing in the store. Code holding only
// an instant cannot recover it without knowing where the store is. That is the
// whole of the bug, and the whole of the fix.
//
// Severity scales with longitude. An Eastern store closing at 5pm never
// crosses; open until 9pm and the evening moves. A Pacific deployment is UTC-7,
// so a 4pm sale is already past midnight UTC and most of the afternoon lands on
// the next day.
//
// TWO DIFFERENT JOBS, and conflating them is what produced this:
//
//   DISPLAYING an instant ("placed at 3:42pm") follows the VIEWER's clock,
//   falling back to the deployment's timezone when the browser cannot be
//   determined. Someone in Denver reading a Connecticut order sees their own
//   local time; that is useful and harmless. That is lib/dateUtils.ts's job.
//
//   BUCKETING into a day ("which day's sales is this") follows the
//   DEPLOYMENT, never the viewer -- otherwise two people running the same
//   report get different daily totals. This file's job.
//
// Same stored instant, two different questions.
//
// The timezone is NOT a new setting. `AppSettings.timezone` already exists,
// already has an admin field, and is already read by the blog, bookings and
// email. The reports layer simply never asked -- none of the 36 modules under
// lib/reports/ reads app settings at all, which is also why so many deployment
// facts ended up as literals in those files. This is the first one to ask.

import { getAppSettings } from "@/lib/appSettings";

/**
 * The deployment's business timezone. Cached 60s inside getAppSettings, and it
 * falls back to defaults rather than throwing, so a report never fails because
 * settings were unreadable.
 */
export async function getBusinessTimeZone(): Promise<string> {
  const settings = await getAppSettings();
  return settings.timezone;
}

/**
 * The wall-clock offset of `timeZone` at a given instant, in milliseconds.
 * Positive east of UTC. Derived by formatting the instant into the zone and
 * reading the difference, which is the only way to get it right across DST
 * without shipping a timezone database.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // hour12:false yields "24" for midnight in some ICU versions; % 24 normalises.
  const asIfUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour") % 24,
    at("minute"),
    at("second"),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant at which a business day begins, for `dateStr` (YYYY-MM-DD)
 * in `timeZone`.
 *
 * Two passes, deliberately: the first correction uses the offset at the naive
 * guess, which on a DST-transition day is the offset on the wrong side of the
 * change. The second re-reads it at the corrected instant and converges.
 */
export function businessDayStart(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wallClock = Date.UTC(y, m - 1, d, 0, 0, 0);
  let utc = wallClock;
  for (let pass = 0; pass < 2; pass++) {
    utc = wallClock - zoneOffsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}

/**
 * Half-open range covering one business day: `{ gte, lt }`, ready to hand to a
 * Prisma date filter. Half-open, not inclusive-end, so a sale at 23:59:59.999
 * cannot fall between two days.
 *
 * Derived from the NEXT day's start rather than adding 24 hours, because a
 * DST day is 23 or 25 hours long and adding a fixed day would clip an hour or
 * double-count one twice a year.
 */
export function businessDayRange(dateStr: string, timeZone: string): { gte: Date; lt: Date } {
  const gte = businessDayStart(dateStr, timeZone);
  const [y, m, d] = dateStr.split("-").map(Number);
  const nextStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { gte, lt: businessDayStart(nextStr, timeZone) };
}

/**
 * Which business day an instant belongs to, as YYYY-MM-DD.
 *
 * This is the replacement for `instant.toISOString().slice(0, 10)` anywhere a
 * report groups by day. `en-CA` formats as YYYY-MM-DD, which is why it is used
 * here and in lib/dateUtils.ts rather than assembling the parts by hand.
 */
export function businessDayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
