// /app/src/lib/reports/commissionPayouts.ts
//
// Team commission read-model: LOCKED payouts for flagged designers, serialized
// for the view-only grid. Wraps listCommissionPayouts so the App Router page +
// tRPC procedure share one source of truth. SUPER_ADMIN-only (tabled per owner
// direction 2026-05-29) — managers see numbers, they don't define the comp plan.

import { listCommissionPayouts } from "@/lib/commissionPayoutList";
import { toNumber } from "@/lib/money";

export interface CommissionPayoutRow {
  id: number;
  staffMemberId: number;
  staffMemberName: string;
  periodStart: Date;
  periodEnd: Date;
  periodSalesAmount: number;
  commissionAmount: number;
  lockedAt: Date | null;
  paidOn: Date | null;
}

export interface CommissionPayoutsParams {
  staffMemberId?: number;
  from?: Date | null;
  to?: Date | null;
}

export async function getCommissionPayouts(
  params: CommissionPayoutsParams = {},
): Promise<{ payouts: CommissionPayoutRow[] }> {
  const staffMemberId =
    params.staffMemberId && Number.isFinite(params.staffMemberId)
      ? params.staffMemberId
      : undefined;

  const payouts = await listCommissionPayouts({
    staffMemberId,
    from: params.from ?? null,
    to: params.to ?? null,
    includeDrafts: false, // locked only — managers don't see in-progress drafts
    designersOnly: true, // only staff flagged isDesigner
  });

  const rows: CommissionPayoutRow[] = payouts.map((p) => ({
    id: p.id,
    staffMemberId: p.staffMemberId,
    staffMemberName: p.staffMember.displayName,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    periodSalesAmount: toNumber(p.periodSalesAmount),
    commissionAmount: toNumber(p.commissionAmount),
    lockedAt: p.lockedAt,
    paidOn: p.paidOn,
  }));

  return { payouts: rows };
}
