// /app/src/lib/timeEntries/duration.ts
//
// Pure duration parsing/formatting for time entries (CLAUDE.md rule 14). Accepts
// the shorthands a user types -- "90" (minutes), "45m", "1.5h", "1h30m",
// "1:30" -- and normalises to integer minutes; formatMinutes renders minutes
// back as "1h 30m". No I/O.

export function parseDurationToMinutes(input: string): number {
  const raw = input.trim().toLowerCase();
  if (!raw) throw new Error("Enter a duration");

  let minutes: number | null = null;

  const hoursMatch = raw.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/);
  const clockMatch = raw.match(/^(\d+):([0-5]?\d)$/);
  const minsMatch = raw.match(/^(\d+)\s*m?$/); // "90" or "45m"

  if (hoursMatch) {
    const hours = Number.parseFloat(hoursMatch[1]);
    const extraMins = hoursMatch[2] ? Number.parseInt(hoursMatch[2], 10) : 0;
    minutes = Math.round(hours * 60 + extraMins);
  } else if (clockMatch) {
    minutes = Number.parseInt(clockMatch[1], 10) * 60 + Number.parseInt(clockMatch[2], 10);
  } else if (minsMatch) {
    minutes = Number.parseInt(minsMatch[1], 10);
  }

  if (minutes === null || Number.isNaN(minutes)) {
    throw new Error("Enter time like 90, 1.5h, or 1h30m");
  }
  if (minutes <= 0) throw new Error("Duration must be greater than zero");
  if (minutes > 24 * 60) throw new Error("Duration can't exceed 24 hours");
  return minutes;
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
