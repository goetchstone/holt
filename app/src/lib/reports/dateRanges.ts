// /app/src/lib/reports/dateRanges.ts
//
// Shared MTD/YTD period math for sales reports. Extracted so multiple report
// libs (sales-performance, designer-dashboard, monthly-performance) compute the
// same ranges from one source of truth. Exclusive upper bounds (start of next
// day) so filters are >= start AND < end with no millisecond gaps. Boundaries
// are local midnight in the business timezone the caller passes
// (getBusinessTimeZone); UTC when it passes none.

import { businessDayKey, businessDayStart } from "@/lib/reports/businessDay";

export interface PeriodRange {
  start: Date;
  end: Date;
}

export interface DateRanges {
  currentYear: number;
  prevYear: number;
  mtd: PeriodRange;
  ytd: PeriodRange;
  prevMtd: PeriodRange;
  prevYtd: PeriodRange;
}

export function getDateRanges(asOfDate?: string, timeZone = "UTC"): DateRanges {
  // "Today" is the business day: the as-of date as given, or the current
  // instant's date in `timeZone`. Every boundary is that zone's local midnight
  // (businessDayStart), so an evening sale counts in its own month and year.
  // UTC, the default, keeps the arithmetic callers and tests have always had.
  const todayKey = asOfDate ? asOfDate.slice(0, 10) : businessDayKey(new Date(), timeZone);
  const [year, month, day] = todayKey.split("-").map(Number);
  const prevYear = year - 1;
  const at = (y: number, m: number, d: number) => {
    // Date.UTC normalises an overflowing day (the 32nd) into the next month.
    const key = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
    return businessDayStart(key, timeZone);
  };
  // Prior-year YTD covers Jan 1 of last year through the same calendar day as
  // today, NOT through Dec 31.
  return {
    currentYear: year,
    prevYear,
    mtd: { start: at(year, month, 1), end: at(year, month, day + 1) },
    ytd: { start: at(year, 1, 1), end: at(year, month, day + 1) },
    prevMtd: { start: at(prevYear, month, 1), end: at(prevYear, month, day + 1) },
    prevYtd: { start: at(prevYear, 1, 1), end: at(prevYear, month, day + 1) },
  };
}
