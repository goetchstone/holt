// /app/src/lib/campaignDedup.ts
//
// Pure helpers for the Opportunities hub campaign dedup logic. Split out
// from the drill endpoint so it's unit-testable without Prisma mocks.

export interface RecentTarget {
  customerId: number;
  sentAt: Date;
}

/**
 * Given a set of candidate customer IDs and a log of recent sends for a
 * specific tile, return only the IDs whose most-recent send is older than
 * `windowDays` (or who have never been sent).
 *
 * The input `recent` list must already be filtered to the tile in question
 * -- this function does not cross-check `tileId`.
 */
export function filterOutRecentlySent(
  candidateIds: number[],
  recent: RecentTarget[],
  windowDays: number,
  now: Date,
): number[] {
  const cutoffMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const blocked = new Set<number>();
  for (const t of recent) {
    if (t.sentAt.getTime() >= cutoffMs) blocked.add(t.customerId);
  }
  return candidateIds.filter((id) => !blocked.has(id));
}

/**
 * For the drill response: build a lookup of "days since last send per
 * customerId" so each row can show a "sent Nd ago" chip regardless of
 * whether the dedup filter is on.
 */
export function buildDaysSinceLastSentMap(recent: RecentTarget[], now: Date): Map<number, number> {
  const latest = new Map<number, number>(); // customerId -> timestamp
  for (const t of recent) {
    const ts = t.sentAt.getTime();
    const prev = latest.get(t.customerId);
    if (prev === undefined || ts > prev) latest.set(t.customerId, ts);
  }
  const out = new Map<number, number>();
  for (const [id, ts] of latest) {
    const days = Math.floor((now.getTime() - ts) / (24 * 60 * 60 * 1000));
    out.set(id, Math.max(0, days));
  }
  return out;
}
