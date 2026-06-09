// /app/src/lib/commissionPayoutList.ts
//
// Shared read query for locked/draft commission payouts. Used by the
// SUPER_ADMIN commission-tiers surface (full list incl. drafts) AND the
// MANAGER view-only team-commission report (locked + designers-only).
// One query so the two surfaces can't diverge on filtering.

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

export function listCommissionPayouts(filters: PayoutListFilters) {
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

  return prisma.commissionPayout.findMany({
    where,
    include: { staffMember: { select: { id: true, displayName: true } } },
    orderBy: [{ periodEnd: "desc" }, { commissionAmount: "desc" }],
    take: 500,
  });
}
