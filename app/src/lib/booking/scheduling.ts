// /app/src/lib/booking/scheduling.ts
//
// Shared scheduling primitives for the Service catalog + availability windows
// (CLAUDE.md rule 7: one source of truth for client + server). Pure, no I/O.

export const DAY_OF_WEEK_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function isValidHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// Minutes from midnight for an "HH:MM" string; throws on malformed input so
// callers validate first (the requestBody parser does).
export function hhmmToMinutes(value: string): number {
  if (!isValidHHMM(value)) throw new Error(`Invalid time "${value}" (use HH:MM)`);
  const [h, m] = value.split(":").map((n) => Number.parseInt(n, 10));
  return h * 60 + m;
}

export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

// URL-safe slug from a service name: lowercase words joined by '-'.
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
