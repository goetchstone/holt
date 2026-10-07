// /app/src/lib/dateUtils.ts
//
// Timezone-aware date utilities. The business operates in US Eastern time by
// default but the server typically runs in UTC. All business-day
// boundaries must be computed in Eastern time, then converted to UTC Date
// objects for Prisma queries.

const BUSINESS_TZ = "America/New_York";

// Returns the Eastern-time date string (YYYY-MM-DD) for a given instant.
function easternDateStr(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: BUSINESS_TZ });
}

// Builds a UTC Date for midnight Eastern time on a given YYYY-MM-DD string.
// Uses a binary-search approach: format the candidate UTC instant back to
// Eastern and adjust until the Eastern wall-clock reads 00:00 on the target date.
function midnightEastern(dateStr: string): Date {
  // Parse as noon UTC to avoid any DST edge cases during initial guess
  const [year, month, day] = dateStr.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  // Get the Eastern offset by comparing the formatted date parts
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(guess);

  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "12";
  const hour = Number.parseInt(hourStr, 10);

  // guess is noon UTC; Eastern shows `hour`. The offset from UTC is (12 - hour) hours.
  // Midnight Eastern = UTC midnight + offset hours.
  const offsetHours = 12 - hour;
  return new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0));
}

// Start of the business day (midnight Eastern) for the given instant.
export function startOfBusinessDay(date: Date = new Date()): Date {
  return midnightEastern(easternDateStr(date));
}

// End of the business day (exclusive: midnight Eastern of the next day).
// Use with < (not <=) in queries for clean range boundaries.
export function endOfBusinessDay(date: Date = new Date()): Date {
  const start = startOfBusinessDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

// Parses an ISO date string (from the API) for display without timezone shift.
// Dates stored as midnight UTC (e.g. "2026-03-25T00:00:00.000Z") would show as
// March 24 in US Eastern browsers. This extracts just the YYYY-MM-DD portion and
// parses it as local midnight so the displayed date matches the stored date.
export function parseLocalDate(value: string | Date): Date {
  const str = value instanceof Date ? value.toISOString() : String(value);
  const dateOnly = str.substring(0, 10);
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Same calendar day, one year prior.
export function sameBusinessDayLastYear(date: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const dateStr = easternDateStr(date);
  const [year, month, day] = dateStr.split("-").map(Number);
  const lyStr = `${year - 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const start = midnightEastern(lyStr);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
