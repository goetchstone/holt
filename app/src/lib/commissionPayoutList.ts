// /app/src/lib/commissionPayoutList.ts
//
// The read query for locked and draft commission payouts, behind
// GET /api/admin/reports/commission-payouts (the Payouts tab). `designersOnly`
// has no caller today; it was written for a team view that does not use it.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface PayoutListFilters {
  staffMemberId?: number;
  from?: Date | null;
  to?: Date | null;
  /** Include DRAFT (unlocked) payouts. Default false = locked only. */
  includeDrafts?: boolean;
  /** Restrict to staff flagged isDesigner (the manager team view). */
  designersOnly?: boolean;
}

/** The most payouts one list returns. Past it, the list says it was cut. */
export const PAYOUT_LIST_LIMIT = 500;

/**
 * The newest payouts that match, and whether older ones were left out. The
 * list used to stop at 500 with no sign: after about a year of pay periods the
 * oldest locked payouts dropped off the screen as if they had never been.
 */
export async function listCommissionPayouts(filters: PayoutListFilters) {
  const where: Prisma.CommissionPayoutWhereInput = {};
  if (filters.staffMemberId) where.staffMemberId = filters.staffMemberId;
  if (filters.from || filters.to) {
    where.periodEnd = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  if (!filters.includeDrafts) where.lockedAt = { not: null };
  if (filters.designersOnly) where.staffMember = { isDesigner: true };

  const rows = await prisma.commissionPayout.findMany({
    where,
    include: { staffMember: { select: { id: true, displayName: true } } },
    orderBy: [{ periodEnd: "desc" }, { commissionAmount: "desc" }],
    take: PAYOUT_LIST_LIMIT + 1,
  });
  return { payouts: rows.slice(0, PAYOUT_LIST_LIMIT), truncated: rows.length > PAYOUT_LIST_LIMIT };
}
