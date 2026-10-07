// /app/src/lib/commissionPeriodOverlap.ts
//
// Pure helper: detect when a candidate pay-period range collides with
// any existing CommissionPayout row (draft OR locked). Origin: owner
// direction 2026-05-27 — "once we have a payperiord drafted or locked
// we should not be able to generate new data against it."
//
// Why this matters:
//   - Without the guard, an operator who picks an overlapping range
//     (5/10–5/25 when 5/1–5/15 already exists) writes a NEW row that
//     double-counts the 6 overlap days. Chain continuity also breaks
//     because the "most recent locked period BEFORE this one" query
//     can't tell where one period ends and the next starts.
//   - The `@@unique([staffMemberId, periodStart, periodEnd])` index
//     only guards against EXACT duplicates, not date-range overlap.
//     This helper closes that gap.
//
// The rule (in plain English):
//   - An EXACT match of (periodStart, periodEnd) against an existing
//     row is fine — that's an idempotent re-run of the same period.
//     The existing row will UPDATE in place (or be skipped if locked).
//   - ANY other overlap (partial, contained, containing) is REFUSED.
//     The operator must explicitly delete or edit the conflicting
//     row(s) before generating a new range.

export interface PeriodLike {
  /** Sentinel for the operator UI; not used in the math. */
  id?: number;
  periodStart: Date;
  periodEnd: Date;
  /** Optional, for the UI to show "(locked)" / "(draft)" badge. */
  lockedAt?: Date | null;
  /** Optional, for the UI to say which designer. */
  staffMemberId?: number;
  staffMemberDisplayName?: string;
}

/**
 * Two date ranges overlap when the start of one is on or before the
 * end of the other AND vice versa. Both endpoints are inclusive
 * because pay periods include their last day.
 */
function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() <= bEnd.getTime() && aEnd.getTime() >= bStart.getTime();
}

function isExactMatch(a: PeriodLike, candidateStart: Date, candidateEnd: Date): boolean {
  return (
    a.periodStart.getTime() === candidateStart.getTime() &&
    a.periodEnd.getTime() === candidateEnd.getTime()
  );
}

/**
 * Return the existing payouts whose [periodStart, periodEnd] range
 * overlaps [candidateStart, candidateEnd] BUT is NOT an exact match.
 * Exact matches are allowed (idempotent re-run).
 *
 * Sorted by `periodStart` ascending so the UI can show the most-
 * relevant conflict first.
 */
export function findOverlappingPayoutPeriods<T extends PeriodLike>(
  candidateStart: Date,
  candidateEnd: Date,
  existing: ReadonlyArray<T>,
): T[] {
  if (candidateEnd.getTime() < candidateStart.getTime()) return [];
  return existing
    .filter((row) => {
      if (isExactMatch(row, candidateStart, candidateEnd)) return false;
      return rangesOverlap(row.periodStart, row.periodEnd, candidateStart, candidateEnd);
    })
    .slice()
    .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
}

/**
 * Format a single conflict row for the operator-facing error message.
 * Locked status drives the wording — locked rows can't be deleted at
 * all (must be unlocked first), so the prompt is sharper.
 */
export function describeOverlap<T extends PeriodLike>(row: T): string {
  const lockedSuffix = row.lockedAt ? " (LOCKED)" : " (draft)";
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const designer = row.staffMemberDisplayName ? ` ${row.staffMemberDisplayName}` : "";
  return `${fmt(row.periodStart)} – ${fmt(row.periodEnd)}${designer}${lockedSuffix}`;
}
