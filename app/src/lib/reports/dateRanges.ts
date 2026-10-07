// /app/src/lib/reports/dateRanges.ts
//
// Shared MTD/YTD period math for sales reports. Extracted so multiple report
// libs (sales-performance, designer-dashboard, monthly-performance) compute the
// same ranges from one source of truth. All ranges use UTC and exclusive upper
// bounds (start of next day) so filters are >= start AND < end with no
// millisecond gaps.

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

export function getDateRanges(asOfDate?: string): DateRanges {
  // When asOfDate is an ISO date string like "2026-03-24", new Date() parses it
  // as midnight UTC, so getUTC* methods return the expected values. With no
  // asOfDate we use the current instant and extract its UTC components.
  const now = asOfDate ? new Date(asOfDate) : new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const prevYear = year - 1;

  const mtdStart = new Date(Date.UTC(year, month, 1));
  const mtdEnd = new Date(Date.UTC(year, month, day + 1));

  const ytdStart = new Date(Date.UTC(year, 0, 1));
  const ytdEnd = new Date(Date.UTC(year, month, day + 1));

  const prevMtdStart = new Date(Date.UTC(prevYear, month, 1));
  const prevMtdEnd = new Date(Date.UTC(prevYear, month, day + 1));

  const prevYtdStart = new Date(Date.UTC(prevYear, 0, 1));
  // Prior-year YTD covers Jan 1 of last year through the same calendar day as
  // today, NOT through Dec 31.
  const prevYtdEnd = new Date(Date.UTC(prevYear, month, day + 1));

  return {
    currentYear: year,
    prevYear,
    mtd: { start: mtdStart, end: mtdEnd },
    ytd: { start: ytdStart, end: ytdEnd },
    prevMtd: { start: prevMtdStart, end: prevMtdEnd },
    prevYtd: { start: prevYtdStart, end: prevYtdEnd },
  };
}
