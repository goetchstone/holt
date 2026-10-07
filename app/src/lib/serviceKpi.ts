// /app/src/lib/serviceKpi.ts
//
// Pure KPI math for the customer-service manager report. The API
// route (pages/api/reports/service.ts) queries Prisma and hands
// already-shaped objects to `computeServiceKpis`; that lets the
// math be exercised by unit tests without a database.
//
// Two metric families:
//
//   1. Resolution-time on closed cases — avg, median, p90, %
//      resolved within the goal. Pulled from the
//      `closedSamples` array (created+resolvedAt pairs).
//
//   2. Open-queue health — total open, by-status breakdown, age
//      bucket counts, currently-waiting-externally count (sum of
//      cases whose status matches one of the configured names).

export interface ClosedCaseSample {
  createdAt: Date;
  resolvedAt: Date;
}

export interface OpenCaseSample {
  id: number;
  createdAt: Date;
  statusName: string;
}

export interface ServiceKpiInput {
  openCases: OpenCaseSample[];
  closedSamples: ClosedCaseSample[];
  /** Same shape as closedSamples but pulled over a different (longer) window for the trend chart. */
  trendSamples: ClosedCaseSample[];
  goalDays: number;
  externalWaitStatusNames: string[];
  now: Date;
}

export interface ServiceKpis {
  openCount: number;
  closedInWindowCount: number;
  goalDays: number;
  goalMetCount: number;
  goalMetPercent: number;
  avgResolutionDays: number | null;
  medianResolutionDays: number | null;
  p90ResolutionDays: number | null;
  oldestOpenAgeDays: number;
  /** Sum of all open cases whose status matches one of the configured waiting names. */
  waitingExternallyCount: number;
  /** Per-status open counts, sorted descending. */
  openByStatus: { statusName: string; count: number }[];
  /** Age-bucket histogram for open cases. */
  ageBuckets: AgeBucket[];
  /** Per-month resolution-time averages, oldest-first. */
  resolutionTrend: ResolutionTrendPoint[];
}

export interface AgeBucket {
  label: string;
  /** Inclusive lower bound, in days. */
  minDays: number;
  /** Exclusive upper bound, or null for the open-ended bucket. */
  maxDays: number | null;
  count: number;
}

export interface ResolutionTrendPoint {
  /** "2025-10" — YYYY-MM. */
  month: string;
  /** Count of closed cases resolved in that month. */
  closedCount: number;
  /** Mean resolution time across those cases. */
  avgDays: number;
}

const DAY_MS = 1000 * 60 * 60 * 24;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, (b.getTime() - a.getTime()) / DAY_MS);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const AGE_BUCKETS_DEF = [
  { label: "< 7 days", minDays: 0, maxDays: 7 },
  { label: "7–30 days", minDays: 7, maxDays: 30 },
  { label: "30–60 days", minDays: 30, maxDays: 60 },
  { label: "60+ days", minDays: 60, maxDays: null },
] as const;

function bucketAge(ageDays: number): number {
  for (let i = 0; i < AGE_BUCKETS_DEF.length; i++) {
    const b = AGE_BUCKETS_DEF[i];
    if (b.maxDays === null) return i;
    if (ageDays < b.maxDays) return i;
  }
  return AGE_BUCKETS_DEF.length - 1;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function computeServiceKpis(input: ServiceKpiInput): ServiceKpis {
  const { openCases, closedSamples, trendSamples, goalDays, externalWaitStatusNames, now } = input;

  // ── Resolution-time stats ────────────────────────────────────
  const resolutionDays = closedSamples.map((c) => daysBetween(c.createdAt, c.resolvedAt));
  const goalMetCount = resolutionDays.filter((d) => d <= goalDays).length;
  const avg =
    resolutionDays.length === 0
      ? null
      : round1(resolutionDays.reduce((a, b) => a + b, 0) / resolutionDays.length);
  const med = resolutionDays.length === 0 ? null : round1(median(resolutionDays));
  const p90 = resolutionDays.length === 0 ? null : round1(percentile(resolutionDays, 90));

  // ── Open queue ───────────────────────────────────────────────
  const externalWaitSet = new Set(externalWaitStatusNames.map((s) => s.toLowerCase()));
  let waitingExternallyCount = 0;
  let oldestOpenAgeDays = 0;
  const ageBucketCounts = AGE_BUCKETS_DEF.map(() => 0);
  const byStatusMap = new Map<string, number>();

  for (const c of openCases) {
    const age = Math.floor(daysBetween(c.createdAt, now));
    oldestOpenAgeDays = Math.max(oldestOpenAgeDays, age);
    ageBucketCounts[bucketAge(age)] += 1;
    if (externalWaitSet.has(c.statusName.toLowerCase())) waitingExternallyCount += 1;
    byStatusMap.set(c.statusName, (byStatusMap.get(c.statusName) ?? 0) + 1);
  }

  const openByStatus = Array.from(byStatusMap.entries())
    .map(([statusName, count]) => ({ statusName, count }))
    .sort((a, b) => b.count - a.count);

  // ── Resolution trend (per-month avg over the trendSamples window) ─
  const trendMap = new Map<string, { sum: number; count: number }>();
  for (const c of trendSamples) {
    const key = monthKey(c.resolvedAt);
    const cur = trendMap.get(key) ?? { sum: 0, count: 0 };
    cur.sum += daysBetween(c.createdAt, c.resolvedAt);
    cur.count += 1;
    trendMap.set(key, cur);
  }
  const resolutionTrend: ResolutionTrendPoint[] = Array.from(trendMap.entries())
    .map(([month, { sum, count }]) => ({
      month,
      closedCount: count,
      avgDays: round1(sum / count),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    openCount: openCases.length,
    closedInWindowCount: closedSamples.length,
    goalDays,
    goalMetCount,
    goalMetPercent:
      resolutionDays.length === 0 ? 0 : Math.round((goalMetCount / resolutionDays.length) * 100),
    avgResolutionDays: avg,
    medianResolutionDays: med,
    p90ResolutionDays: p90,
    oldestOpenAgeDays,
    waitingExternallyCount,
    openByStatus,
    ageBuckets: AGE_BUCKETS_DEF.map((def, i) => ({
      label: def.label,
      minDays: def.minDays,
      maxDays: def.maxDays,
      count: ageBucketCounts[i],
    })),
    resolutionTrend,
  };
}
