// /app/src/lib/payPeriodLock.ts
//
// Pure logic for the pay-period attribution lock. No I/O — callers
// hand in the active confirmations; this decides whether a given
// order's salesperson attribution is frozen, and whether a period is
// even confirmable yet.
//
// Used by ONE shared guard that every attribution-mutation path calls
// (the daily import, the FK backfill sweep, and the three in-ERP
// reassignment endpoints) so the lock can't be half-enforced.
//
// See docs/domains/commission.md "Pay-period confirmation +
// attribution lock". Origin: owner direction 2026-05-29.

/** Minimal shape of a confirmation row needed for lock decisions. */
export interface ActiveConfirmationLike {
  staffMemberId: number;
  periodStart: Date;
  /** Inclusive last-day midnight (UTC), as stored. */
  periodEnd: Date;
  /** Null ⇒ active (locking). Non-null ⇒ reopened, not locking. */
  reopenedAt: Date | null;
}

const MS_PER_DAY = 86_400_000;

/** Inclusive periodEnd → exclusive upper bound (start of the next day). */
function endExclusive(periodEnd: Date): number {
  return periodEnd.getTime() + MS_PER_DAY;
}

/**
 * Does `orderDate` fall inside `[periodStart, periodEnd]` (inclusive
 * of the whole last day)?
 */
export function periodContainsOrderDate(
  orderDate: Date,
  periodStart: Date,
  periodEnd: Date,
): boolean {
  const t = orderDate.getTime();
  return t >= periodStart.getTime() && t < endExclusive(periodEnd);
}

/**
 * Is the attribution for an order LOCKED? True when ANY of the given
 * designer ids has an ACTIVE confirmation whose period contains the
 * order's date.
 *
 * `designerIds` should include both the order's CURRENT designers
 * (salesPersonId + splitWithId) and, for a reassignment, the TARGET
 * designer(s) — moving an order INTO a locked designer's period would
 * inflate their confirmed numbers just as much as moving one OUT.
 *
 * `orderDate` null ⇒ never locked (can't place it in a period).
 */
export function isAttributionLocked(
  orderDate: Date | null | undefined,
  designerIds: ReadonlyArray<number | null | undefined>,
  activeConfirmations: ReadonlyArray<ActiveConfirmationLike>,
): boolean {
  if (!orderDate) return false;
  const ids = new Set(designerIds.filter((d): d is number => typeof d === "number"));
  if (ids.size === 0) return false;
  return activeConfirmations.some(
    (c) =>
      c.reopenedAt === null &&
      ids.has(c.staffMemberId) &&
      periodContainsOrderDate(orderDate, c.periodStart, c.periodEnd),
  );
}

/**
 * Find the specific active confirmation that locks an order (for
 * building a useful error message), or null.
 */
export function findLockingConfirmation(
  orderDate: Date | null | undefined,
  designerIds: ReadonlyArray<number | null | undefined>,
  activeConfirmations: ReadonlyArray<ActiveConfirmationLike>,
): ActiveConfirmationLike | null {
  if (!orderDate) return null;
  const ids = new Set(designerIds.filter((d): d is number => typeof d === "number"));
  if (ids.size === 0) return null;
  return (
    activeConfirmations.find(
      (c) =>
        c.reopenedAt === null &&
        ids.has(c.staffMemberId) &&
        periodContainsOrderDate(orderDate, c.periodStart, c.periodEnd),
    ) ?? null
  );
}

/** A confirmation enriched with the designer's matchable names. */
export interface ActiveConfirmationWithNames extends ActiveConfirmationLike {
  /** displayName + aliases, for matching the `salesperson` STRING. */
  names: string[];
}

/**
 * Is an order's attribution locked, matching by EITHER the FK
 * (salesPersonId / splitWithId) OR the `salesperson` string?
 *
 * The string match matters because the daily import writes the
 * `salesperson` STRING and the FK is often NULL until the post-import
 * backfill sweep resolves it. An FK-only check would miss exactly the
 * orders the import is about to re-attribute. Names are matched
 * case-insensitively (the POS's casing is inconsistent).
 */
export function isOrderLockedByNameOrFk(
  order: {
    orderDate: Date | null;
    salesPersonId: number | null;
    splitWithId: number | null;
    salesperson: string | null;
  },
  confirmations: ReadonlyArray<ActiveConfirmationWithNames>,
): boolean {
  if (!order.orderDate) return false;
  const salespersonLc = order.salesperson?.trim().toLowerCase() ?? null;
  return confirmations.some((c) => {
    if (c.reopenedAt !== null) return false;
    if (!periodContainsOrderDate(order.orderDate!, c.periodStart, c.periodEnd)) return false;
    if (c.staffMemberId === order.salesPersonId || c.staffMemberId === order.splitWithId) {
      return true;
    }
    return salespersonLc !== null && c.names.some((n) => n.trim().toLowerCase() === salespersonLc);
  });
}

/**
 * Can a period be confirmed yet? A period is confirmable only once it
 * has fully ENDED — you can't lock a period that's still in progress
 * (owner direction 2026-05-29). "Ended" = the day AFTER periodEnd has
 * started in the comparison clock.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }` so the API can
 * surface a clear message.
 */
export function isPeriodConfirmable(
  periodEnd: Date,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (now.getTime() < endExclusive(periodEnd)) {
    return {
      ok: false,
      reason: "This pay period hasn't ended yet — you can confirm it once the period is over.",
    };
  }
  return { ok: true };
}
