// /app/src/lib/payPeriodLockGuard.ts
//
// DB-aware guard around the pure pay-period lock logic in
// `payPeriodLock.ts`. ONE place loads the active confirmations and
// throws a typed error so every attribution-mutation path enforces
// the lock identically (rule 42 — a guard on one path but not
// another is how SO-39275 recurred).
//
// Callers: the three in-ERP reassignment endpoints
// (orders/[id]/salesperson, admin/sales/bulk-update-salesperson,
// reports/pipeline-reassign) use `assertReassignAllowed`. The daily
// import + FK backfill load confirmations once via
// `loadActiveConfirmations` and use the pure `isAttributionLocked`
// to PRESERVE rather than reject.

import { prisma } from "@/lib/prisma";
import {
  isAttributionLocked,
  findLockingConfirmation,
  type ActiveConfirmationLike,
  type ActiveConfirmationWithNames,
} from "@/lib/payPeriodLock";

export class AttributionLockedError extends Error {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly staffMemberId: number;
  constructor(conf: ActiveConfirmationLike) {
    super(
      "This order's pay period has been confirmed/locked. Salesperson attribution for it can't change. A manager must reopen the period first.",
    );
    this.name = "AttributionLockedError";
    this.periodStart = conf.periodStart;
    this.periodEnd = conf.periodEnd;
    this.staffMemberId = conf.staffMemberId;
  }
}

/** Active (locking) confirmations only — `reopenedAt IS NULL`. */
export async function loadActiveConfirmations(): Promise<ActiveConfirmationLike[]> {
  const rows = await prisma.payPeriodConfirmation.findMany({
    where: { reopenedAt: null },
    select: { staffMemberId: true, periodStart: true, periodEnd: true, reopenedAt: true },
  });
  return rows;
}

/**
 * Active confirmations enriched with each designer's matchable names
 * (displayName + aliases) so the daily import can lock orders by the
 * `salesperson` STRING, not just the FK. Returns [] when nothing is
 * locked (the common case — one query short-circuits).
 */
export async function loadActiveConfirmationsWithNames(): Promise<ActiveConfirmationWithNames[]> {
  const rows = await prisma.payPeriodConfirmation.findMany({
    where: { reopenedAt: null },
    select: {
      staffMemberId: true,
      periodStart: true,
      periodEnd: true,
      reopenedAt: true,
      staffMember: { select: { displayName: true, aliases: true } },
    },
  });
  return rows.map((r) => ({
    staffMemberId: r.staffMemberId,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    reopenedAt: r.reopenedAt,
    names: [r.staffMember.displayName, ...(r.staffMember.aliases ?? [])],
  }));
}

/**
 * Throw `AttributionLockedError` if reassigning this order would
 * touch a locked designer's confirmed period — checks BOTH the
 * order's current designers (moving credit OUT) AND the target
 * designers (moving credit IN).
 *
 * Pass `confirmations` to reuse an already-loaded list (bulk
 * endpoint); omit it to load fresh.
 */
export async function assertReassignAllowed(args: {
  orderDate: Date | null;
  currentDesignerIds: ReadonlyArray<number | null | undefined>;
  targetDesignerIds: ReadonlyArray<number | null | undefined>;
  confirmations?: ActiveConfirmationLike[];
}): Promise<void> {
  const confirmations = args.confirmations ?? (await loadActiveConfirmations());
  const allIds = [...args.currentDesignerIds, ...args.targetDesignerIds];
  if (isAttributionLocked(args.orderDate, allIds, confirmations)) {
    const conf = findLockingConfirmation(args.orderDate, allIds, confirmations);
    if (conf) throw new AttributionLockedError(conf);
  }
}
