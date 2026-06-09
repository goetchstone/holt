// /app/src/lib/trafficSummary.ts
//
// Pure helpers that roll up TrafficSnapshot rows into the shapes the
// future reports + dashboard charts need. No I/O — the caller hands
// in an array of rows; we produce aggregations. That keeps the math
// testable without a DB.
//
// Companion piece to `lib/runTrafficImport.ts` (which does the I/O).

/** Minimal shape needed for rollups — accepts any row with these fields. */
export interface TrafficRowForSummary {
  intervalStart: Date;
  axperStoreName: string;
  /** FK on the persisted row; null when no StoreLocation mapping exists. */
  storeLocationId: number | null;
  visitors: number;
  exits?: number | null;
}

export interface DayRollup {
  /** "YYYY-MM-DD" in store-local time. */
  date: string;
  visitors: number;
  exits: number | null;
}

export interface StoreRollup {
  /** The traffic-counter-side name (e.g. "Main Showroom", "West Showroom"). */
  axperStoreName: string;
  /** Resolved StoreLocation FK, or null when unmapped. */
  storeLocationId: number | null;
  visitors: number;
  exits: number | null;
}

export interface DayStoreRollup {
  date: string;
  axperStoreName: string;
  storeLocationId: number | null;
  visitors: number;
  exits: number | null;
}

/**
 * "YYYY-MM-DD" key for a Date using its LOCAL clock. We treat
 * `intervalStart` as already-stored in the store's local clock so
 * the report renders the same calendar day the operator expects.
 */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sumNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Sum visitors + exits by calendar day. Sorted oldest → newest.
 */
export function rollupByDay(rows: ReadonlyArray<TrafficRowForSummary>): DayRollup[] {
  const m = new Map<string, DayRollup>();
  for (const r of rows) {
    const k = dayKey(r.intervalStart);
    const existing = m.get(k);
    if (existing) {
      existing.visitors += r.visitors;
      existing.exits = sumNullable(existing.exits, r.exits);
    } else {
      m.set(k, { date: k, visitors: r.visitors, exits: r.exits ?? null });
    }
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Sum visitors + exits across the whole input by store. Sorted by
 * visitors desc (busiest store first).
 */
export function rollupByStore(rows: ReadonlyArray<TrafficRowForSummary>): StoreRollup[] {
  const m = new Map<string, StoreRollup>();
  for (const r of rows) {
    const k = r.axperStoreName;
    const existing = m.get(k);
    if (existing) {
      existing.visitors += r.visitors;
      existing.exits = sumNullable(existing.exits, r.exits);
    } else {
      m.set(k, {
        axperStoreName: k,
        storeLocationId: r.storeLocationId,
        visitors: r.visitors,
        exits: r.exits ?? null,
      });
    }
  }
  return [...m.values()].sort((a, b) => b.visitors - a.visitors);
}

/**
 * Two-dimensional rollup — one row per (day, store). Useful for
 * stacked-bar charts and per-store conversion-rate calculations.
 * Sorted by (date asc, visitors desc within the day).
 */
export function rollupByDayAndStore(rows: ReadonlyArray<TrafficRowForSummary>): DayStoreRollup[] {
  const m = new Map<string, DayStoreRollup>();
  for (const r of rows) {
    const d = dayKey(r.intervalStart);
    const k = `${d}|${r.axperStoreName}`;
    const existing = m.get(k);
    if (existing) {
      existing.visitors += r.visitors;
      existing.exits = sumNullable(existing.exits, r.exits);
    } else {
      m.set(k, {
        date: d,
        axperStoreName: r.axperStoreName,
        storeLocationId: r.storeLocationId,
        visitors: r.visitors,
        exits: r.exits ?? null,
      });
    }
  }
  return [...m.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return b.visitors - a.visitors;
  });
}

/**
 * Total visitors + exits across the whole input. Handy for the
 * top-of-report KPI cards.
 */
export function totalVisitors(rows: ReadonlyArray<TrafficRowForSummary>): {
  visitors: number;
  exits: number | null;
} {
  let visitors = 0;
  let exits: number | null = null;
  for (const r of rows) {
    visitors += r.visitors;
    exits = sumNullable(exits, r.exits);
  }
  return { visitors, exits };
}

/**
 * Compute a conversion rate (transactions / visitors), guarding
 * against division-by-zero. Returns null when visitors === 0 so
 * the UI can render "—" instead of "Infinity%".
 */
export function conversionRate(transactions: number, visitors: number): number | null {
  if (visitors <= 0) return null;
  return transactions / visitors;
}

/** Visitors aggregated by hour-of-day (0..23). */
export interface HourRollup {
  /** 0..23 (local store-clock hour). */
  hour: number;
  visitors: number;
}

/**
 * Sum visitors by hour-of-day across the input. Useful for "what's
 * the busiest part of the day" charts. The hour comes from the
 * row's `intervalStart` in LOCAL time — we treat the stored
 * wall-clock as the store's local hour, which is what we want
 * because stores are assumed to share one timezone. Returns 24
 * rows (0..23) sorted ascending; hours with zero traffic stay at 0
 * rather than being dropped so the chart x-axis is always uniform.
 */
export function rollupByHour(rows: ReadonlyArray<TrafficRowForSummary>): HourRollup[] {
  const counts = new Array<number>(24).fill(0);
  for (const r of rows) {
    const h = r.intervalStart.getHours();
    if (h >= 0 && h <= 23) counts[h] += r.visitors;
  }
  return counts.map((visitors, hour) => ({ hour, visitors }));
}

/** Visitors aggregated by day-of-week (0..6 = Sun..Sat). */
export interface DayOfWeekRollup {
  /** 0=Sunday .. 6=Saturday — matches `Date.getDay()`. */
  dow: number;
  visitors: number;
}

/**
 * Sum visitors by day-of-week across the input. Returns Sun..Sat
 * in that order (7 rows, zero-filled). Useful for "which day is
 * busiest" charts where the y-axis is summed visitors across the
 * whole input range.
 */
export function rollupByDayOfWeek(rows: ReadonlyArray<TrafficRowForSummary>): DayOfWeekRollup[] {
  const counts = new Array<number>(7).fill(0);
  for (const r of rows) {
    const d = r.intervalStart.getDay();
    if (d >= 0 && d <= 6) counts[d] += r.visitors;
  }
  return counts.map((visitors, dow) => ({ dow, visitors }));
}
