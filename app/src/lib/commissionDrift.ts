// /app/src/lib/commissionDrift.ts
//
// Locked-payout drift detection. Owner direction 2026-05-27 follow-up
// audit — the v1 lock-it-in design didn't account for late-landing
// returns / rewrites / cancellations / reassignments whose order date
// falls INSIDE a locked period but whose import lands AFTER the lock.
//
// Each locked payout stamps `ytdSalesAtEnd` at lock-time. Drift =
// (live recompute of [yearStart, lockedRow.periodEnd] sales for this
// designer) − lockedRow.ytdSalesAtEnd. Non-zero drift means the
// underlying data shifted since the row locked.
//
// Two correct dispositions for non-zero drift:
//   (a) Accept the variance — leave the lock alone. The cash already
//       went out; the books carry the difference forward into the
//       next period's slice via chain continuity (the next period's
//       ytdAtStart = THIS lock's ytdAtEnd, frozen).
//   (b) Claw back — SUPER_ADMIN unlocks the row, edits commissionAmount
//       to the correct value, re-locks. Every change writes a
//       CommissionPayoutEdit audit row with the reason.
//
// This module produces the drift report. The endpoint + admin UI
// surface it; the operator chooses (a) or (b) per row.

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sumDesignerSales } from "@/lib/commissionSales";
import { resolvePlanRulesForStaff } from "@/lib/commissionRules";

/** Tolerance in dollars before we consider a difference "drift". */
const DRIFT_TOLERANCE = 0.01;

export interface LockedPayoutDriftRow {
  payoutId: number;
  staffMemberId: number;
  displayName: string;
  periodStart: Date;
  periodEnd: Date;
  lockedYtdAtEnd: number;
  liveYtdAtEnd: number;
  /** liveYtdAtEnd - lockedYtdAtEnd (signed). Negative = returns/cancellations landed after lock. */
  drift: number;
  /** Frozen commission paid; the operator may need to claw back if drift is negative. */
  lockedCommissionAmount: number;
  lockedAt: Date;
  lockedBy: string | null;
}

interface LockedPayoutForDrift {
  id: number;
  staffMemberId: number;
  periodStart: Date;
  periodEnd: Date;
  ytdSalesAtEnd: { toString(): string };
  commissionAmount: { toString(): string };
  lockedAt: Date | null;
  lockedBy: string | null;
  staffMember: {
    id: number;
    displayName: string;
    aliases: string[];
  };
}

/** The most locked payouts one drift check looks at, newest first. */
export const DRIFT_CHECK_LIMIT = 1000;

/**
 * Compute drift for every currently-locked payout. Optionally narrow
 * to one designer. Rows with |drift| <= DRIFT_TOLERANCE are excluded
 * unless `includeClean` is true.
 *
 * Reads the newest DRIFT_CHECK_LIMIT locked rows in one pass and runs one
 * live-sum query per row. `checked` is how many it looked at and `truncated`
 * whether older locks were left unchecked, so "no drift" is never said about
 * payouts nobody looked at.
 */
export async function computeLockedPayoutDrift(opts?: {
  staffMemberId?: number;
  includeClean?: boolean;
  client?: PrismaClient;
}): Promise<{ rows: LockedPayoutDriftRow[]; checked: number; truncated: boolean }> {
  const client = opts?.client ?? prisma;
  const found = (await client.commissionPayout.findMany({
    where: {
      lockedAt: { not: null },
      ...(opts?.staffMemberId ? { staffMemberId: opts.staffMemberId } : {}),
    },
    include: {
      staffMember: { select: { id: true, displayName: true, aliases: true } },
    },
    orderBy: [{ periodEnd: "desc" }, { staffMemberId: "asc" }],
    take: DRIFT_CHECK_LIMIT + 1,
  })) as unknown as LockedPayoutForDrift[];
  const locked = found.slice(0, DRIFT_CHECK_LIMIT);

  const rows: LockedPayoutDriftRow[] = [];

  for (const row of locked) {
    // Same year-anchor as the orchestrator uses. Chain continuity
    // resets at year boundary, so drift detection does too.
    const yearStart = new Date(Date.UTC(row.periodStart.getUTCFullYear(), 0, 1));
    // periodEnd is INCLUSIVE; sum extends through the next day at
    // 00:00 UTC to mirror previewPayoutsForPeriod's behavior.
    const periodEndExclusive = new Date(row.periodEnd);
    periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);

    const matchNames = [row.staffMember.displayName, ...(row.staffMember.aliases ?? [])];
    // Recompute on the SAME basis the payout was generated on. Comparing a
    // DELIVERED-basis lock against a WRITTEN-basis recomputation would report
    // drift on every payout that had none.
    const rules = await resolvePlanRulesForStaff([row.staffMember.id]);
    const liveYtdAtEnd = await sumDesignerSales(
      row.staffMember.id,
      matchNames,
      yearStart,
      periodEndExclusive,
      rules.get(row.staffMember.id)?.countsWhen ?? "WRITTEN",
    );

    const lockedYtdAtEnd = Number(row.ytdSalesAtEnd);
    const drift = round2(liveYtdAtEnd - lockedYtdAtEnd);

    if (!opts?.includeClean && Math.abs(drift) <= DRIFT_TOLERANCE) continue;

    rows.push({
      payoutId: row.id,
      staffMemberId: row.staffMemberId,
      displayName: row.staffMember.displayName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      lockedYtdAtEnd: round2(lockedYtdAtEnd),
      liveYtdAtEnd: round2(liveYtdAtEnd),
      drift,
      lockedCommissionAmount: Number(row.commissionAmount),
      lockedAt: row.lockedAt as Date,
      lockedBy: row.lockedBy,
    });
  }

  return { rows, checked: locked.length, truncated: found.length > DRIFT_CHECK_LIMIT };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
