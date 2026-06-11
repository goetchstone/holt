// /app/src/lib/runCommissionPayouts.ts
//
// Orchestrator for the commission-payout lock-in flow. Three entry
// points used by the API layer:
//
//   - previewPayoutsForPeriod(start, end) → computes drafts for every
//     active designer/manager. No DB writes.
//   - commitPayoutsForPeriod(start, end, overrides, opts) → writes the
//     drafts as CommissionPayout rows (upsert by unique
//     (staffMemberId, periodStart, periodEnd)). Optionally locks them
//     in the same transaction.
//   - editPayout(payoutId, patch, reason, editedBy) → updates fields
//     on an existing row and writes a CommissionPayoutEdit audit
//     entry per changed field.
//
// Origin: owner direction 2026-05-27 — "lock it in so the Google Sheet
// drift goes away."

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sumDesignerSales } from "@/lib/commissionSales";
import { computePayoutForRange, type ComputedPayout } from "@/lib/commissionPayout";
import { findOverlappingPayoutPeriods, describeOverlap } from "@/lib/commissionPeriodOverlap";
import { resolvePlanTiersForStaff } from "@/lib/commissionPlans";

interface ActiveDesigner {
  id: number;
  displayName: string;
  aliases: string[];
}

async function loadActiveDesigners(): Promise<ActiveDesigner[]> {
  return prisma.staffMember.findMany({
    where: { role: { in: ["DESIGNER", "MANAGER"] }, isActive: true },
    select: { id: true, displayName: true, aliases: true },
    orderBy: { displayName: "asc" },
  });
}

/**
 * Get one designer's YTD-at-start + YTD-at-end.
 *
 * **Chain continuity** (CRITICAL — added after the v1 PR audit):
 * when a previous LOCKED payout exists for this designer with
 * `periodEnd < periodStart`, this period's `ytdAtStart` reads from
 * THAT row's frozen `ytdSalesAtEnd`, not from a fresh live sum.
 *
 * Why: if a return / rewrite / cancellation lands AFTER period N
 * is locked but with an order date INSIDE period N, the live
 * [Jan1, period(N+1).start) sum will be smaller than period N's
 * locked `ytdSalesAtEnd`. Without chain continuity, period N+1
 * would re-credit Alice for the missing dollars in a lower tier
 * (or re-pay her at a higher rate when sales later inflate the
 * YTD), and the year-to-date commission Alice receives would not
 * match the marginal math against her true cumulative YTD.
 *
 * With chain continuity, period N's lock sets the floor for period
 * N+1. Returns/edits that land after the lock surface as DRIFT
 * (see `lib/commissionDrift.ts`) and the operator decides whether
 * to claw back via unlock-and-edit (with audit reason) or accept
 * the variance.
 *
 * Falls back to the live-sum path when no prior lock exists (the
 * first-ever period for a designer, or fresh dev DBs).
 */
export async function computeDesignerYtdSums(
  staff: ActiveDesigner,
  periodStart: Date,
  periodEndExclusive: Date,
): Promise<{ ytdAtStart: number; ytdAtEnd: number; chainedFromPayoutId: number | null }> {
  const yearStart = new Date(Date.UTC(periodStart.getUTCFullYear(), 0, 1));
  const matchNames = [staff.displayName, ...(staff.aliases ?? [])];

  // Look for the most recent LOCKED payout that ENDED before this
  // period started. If found, its frozen ytdSalesAtEnd is our
  // ytdAtStart. Limit to the current year so a Dec-2025 lock doesn't
  // carry into a 2026 period (year-anchor reset).
  const priorLock = await prisma.commissionPayout.findFirst({
    where: {
      staffMemberId: staff.id,
      lockedAt: { not: null },
      periodEnd: { lt: periodStart, gte: yearStart },
    },
    orderBy: { periodEnd: "desc" },
    select: { id: true, ytdSalesAtEnd: true },
  });

  const ytdAtStart = priorLock
    ? Number(priorLock.ytdSalesAtEnd)
    : await sumDesignerSales(staff.id, matchNames, yearStart, periodStart);
  const ytdAtEnd = await sumDesignerSales(staff.id, matchNames, yearStart, periodEndExclusive);

  return {
    ytdAtStart,
    ytdAtEnd,
    chainedFromPayoutId: priorLock?.id ?? null,
  };
}

export interface PreviewedPayout extends ComputedPayout {
  displayName: string;
  // Which plan priced this draft (resolved per designer; null planId = the
  // legacy tier table / built-in defaults). Frozen onto the payout row at
  // commit so history records who was paid under which structure.
  commissionPlanId: number | null;
  commissionPlanName: string;
}

/**
 * Compute drafts for every active designer for a date range. No DB
 * writes. The API route returns this directly so the UI can render
 * a preview table; the operator confirms + commits.
 */
export async function previewPayoutsForPeriod(
  periodStart: Date,
  periodEnd: Date,
): Promise<PreviewedPayout[]> {
  const designers = await loadActiveDesigners();
  // Per-designer tier resolution: assigned plan -> default plan -> legacy
  // tier table -> built-in defaults. Chain continuity (ytdAtStart from the
  // prior locked payout) is plan-independent — it carries sales DOLLARS, so a
  // mid-year plan switch keeps the YTD position and simply prices subsequent
  // slices through the new plan's brackets.
  const planTiers = await resolvePlanTiersForStaff(designers.map((d) => d.id));

  // Make the period endpoint inclusive by extending to end-of-day.
  const periodEndExclusive = new Date(periodEnd);
  periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);

  const out: PreviewedPayout[] = [];
  for (const s of designers) {
    const resolved = planTiers.get(s.id);
    if (!resolved) continue;
    const { ytdAtStart, ytdAtEnd } = await computeDesignerYtdSums(
      s,
      periodStart,
      periodEndExclusive,
    );
    const computed = computePayoutForRange({
      staffMemberId: s.id,
      periodStart,
      periodEnd,
      ytdSalesAtStart: ytdAtStart,
      ytdSalesAtEnd: ytdAtEnd,
      tiers: resolved.tiers,
    });
    out.push({
      ...computed,
      displayName: s.displayName,
      commissionPlanId: resolved.planId,
      commissionPlanName: resolved.planName,
    });
  }

  // Sort by commission desc (most-paid first), then alphabetical.
  out.sort((a, b) => {
    if (b.commissionAmount !== a.commissionAmount) {
      return b.commissionAmount - a.commissionAmount;
    }
    return a.displayName.localeCompare(b.displayName);
  });

  return out;
}

export interface PayoutOverride {
  staffMemberId: number;
  /** Override only one or both of these if the operator hand-edited. */
  commissionAmount?: number;
  notes?: string;
  paidOn?: Date | null;
}

export interface CommitPayoutsOptions {
  lockNow: boolean;
  actorEmail: string;
}

export interface CommitResult {
  created: number;
  updated: number;
  payoutIds: number[];
}

/**
 * Find every existing CommissionPayout whose period overlaps the
 * candidate range AND is NOT an exact (periodStart, periodEnd) match.
 * Used to refuse generating a NEW period that would collide with an
 * already-drafted/locked one. Exact-match re-runs (same period dates)
 * are still allowed — that's the idempotent path.
 *
 * Origin: owner direction 2026-05-27 — "once we have a payperiord
 * drafted or locked we should not be able to generate new data
 * against it."
 */
export async function findOverlappingExistingPayouts(
  periodStart: Date,
  periodEnd: Date,
): Promise<OverlapDetail[]> {
  // Database-side overlap filter, then exact-match exclusion in JS
  // (Prisma can't easily express "NOT both columns equal" inline).
  const rows = await prisma.commissionPayout.findMany({
    where: {
      periodStart: { lte: periodEnd },
      periodEnd: { gte: periodStart },
    },
    include: { staffMember: { select: { displayName: true } } },
    orderBy: [{ periodStart: "asc" }],
    take: 200,
  });
  const candidates = rows.map((r) => ({
    id: r.id,
    staffMemberId: r.staffMemberId,
    staffMemberDisplayName: r.staffMember.displayName,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    lockedAt: r.lockedAt,
  }));
  return findOverlappingPayoutPeriods(periodStart, periodEnd, candidates);
}

export interface OverlapDetail {
  id: number;
  staffMemberId: number;
  staffMemberDisplayName: string;
  periodStart: Date;
  periodEnd: Date;
  lockedAt: Date | null;
}

export class OverlappingPeriodError extends Error {
  readonly overlaps: ReadonlyArray<OverlapDetail>;
  constructor(overlaps: ReadonlyArray<OverlapDetail>) {
    super(
      `Requested pay period overlaps ${overlaps.length} existing payout(s): ` +
        overlaps.map((o) => describeOverlap(o)).join("; "),
    );
    this.name = "OverlappingPeriodError";
    this.overlaps = overlaps;
  }
}

/**
 * Write drafts as CommissionPayout rows. Upsert by unique
 * (staffMemberId, periodStart, periodEnd) — if the operator re-runs
 * the same period, existing rows update in place. Overrides let the
 * operator adjust commissionAmount / notes / paidOn at commit time
 * (before lock). All writes happen in one transaction.
 *
 * Refuses to write when the candidate range OVERLAPS an existing
 * payout that isn't an exact match. The operator must delete or edit
 * the conflicting row(s) first — same rule for drafts and locks.
 */
export async function commitPayoutsForPeriod(
  periodStart: Date,
  periodEnd: Date,
  overrides: PayoutOverride[],
  opts: CommitPayoutsOptions,
): Promise<CommitResult> {
  const overlaps = await findOverlappingExistingPayouts(periodStart, periodEnd);
  if (overlaps.length > 0) throw new OverlappingPeriodError(overlaps);

  const drafts = await previewPayoutsForPeriod(periodStart, periodEnd);
  const overrideMap = new Map<number, PayoutOverride>(overrides.map((o) => [o.staffMemberId, o]));

  const result: CommitResult = { created: 0, updated: 0, payoutIds: [] };

  await prisma.$transaction(async (tx) => {
    for (const d of drafts) {
      const ov = overrideMap.get(d.staffMemberId);
      const finalCommissionAmount = ov?.commissionAmount ?? d.commissionAmount;
      const lockedFields = opts.lockNow
        ? { lockedAt: new Date(), lockedBy: opts.actorEmail }
        : { lockedAt: null, lockedBy: null };

      const existing = await tx.commissionPayout.findUnique({
        where: {
          staffMemberId_periodStart_periodEnd: {
            staffMemberId: d.staffMemberId,
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
          },
        },
        select: { id: true, lockedAt: true },
      });

      // Don't touch already-locked rows during a re-commit — the lock
      // is sticky. Operator must explicitly unlock first.
      if (existing?.lockedAt) {
        result.payoutIds.push(existing.id);
        continue;
      }

      const data = {
        staffMemberId: d.staffMemberId,
        periodStart: d.periodStart,
        periodEnd: d.periodEnd,
        periodSalesAmount: d.periodSalesAmount,
        ytdSalesAtStart: d.ytdSalesAtStart,
        ytdSalesAtEnd: d.ytdSalesAtEnd,
        tierBreakdown: d.tierBreakdown as unknown as Prisma.InputJsonValue,
        commissionAmount: finalCommissionAmount,
        tierDefinitionSnapshot: d.tierDefinitionSnapshot as unknown as Prisma.InputJsonValue,
        commissionPlanId: d.commissionPlanId,
        commissionPlanName: d.commissionPlanName,
        notes: ov?.notes ?? null,
        paidOn: ov?.paidOn ?? null,
        ...lockedFields,
        updatedBy: opts.actorEmail,
      };

      if (existing) {
        const updated = await tx.commissionPayout.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        });
        result.updated += 1;
        result.payoutIds.push(updated.id);
      } else {
        const created = await tx.commissionPayout.create({
          data: { ...data, createdBy: opts.actorEmail },
          select: { id: true },
        });
        result.created += 1;
        result.payoutIds.push(created.id);
      }
    }
  });

  return result;
}

// Edit-with-audit

/**
 * Fields a SUPER_ADMIN can patch on a locked (or draft) payout. Each
 * patched field writes a CommissionPayoutEdit row capturing
 * before/after + the operator's audit reason. The lock state itself
 * is patchable via this same path — passing lockedAt explicitly
 * (Date to lock, null to unlock) is the only way to flip it after
 * the initial commit.
 */
export interface PayoutPatch {
  commissionAmount?: number;
  notes?: string | null;
  paidOn?: Date | null;
  lockedAt?: Date | null;
}

export interface EditPayoutOptions {
  reason: string;
  editedBy: string;
}

export interface EditResult {
  payoutId: number;
  editsRecorded: number;
}

const EDITABLE_FIELDS: ReadonlyArray<keyof PayoutPatch> = [
  "commissionAmount",
  "notes",
  "paidOn",
  "lockedAt",
];

function normalizeForDiff(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  // Prisma Decimal (or any object with .toString) → string. Lets us
  // compare a numeric incoming patch value against a Decimal column
  // value without false-positive diffs. Number(3000) and Decimal(3000)
  // both normalize to "3000".
  if (
    typeof value === "object" &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const s = (value as { toString(): string }).toString();
    // Plain JS Date toString isn't useful here (instance check above
    // already caught Dates) — guard against the default `[object …]`
    // shape just in case some other object slipped in.
    if (!s.startsWith("[object ")) return s;
  }
  if (typeof value === "number") return String(value);
  return value;
}

/**
 * Patch one or more fields on a payout. Writes one
 * CommissionPayoutEdit row per field whose value actually changed.
 * Reason + editedBy are recorded on every audit row.
 *
 * lockedAt transitions are handled here too — passing `lockedAt: now`
 * locks the row, passing `lockedAt: null` unlocks. Both record an
 * audit entry with `fieldChanged="lockedAt"` so the unlock-and-
 * re-lock workflow is fully traceable.
 *
 * When lockedAt transitions from null → set, also stamp lockedBy.
 * When transitioning to null, clear lockedBy too.
 */
export async function editPayout(
  payoutId: number,
  patch: PayoutPatch,
  opts: EditPayoutOptions,
): Promise<EditResult> {
  if (!opts.reason || opts.reason.trim().length === 0) {
    throw new Error("audit reason is required");
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.commissionPayout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        commissionAmount: true,
        notes: true,
        paidOn: true,
        lockedAt: true,
        lockedBy: true,
      },
    });
    if (!existing) throw new Error("payout not found");

    const updateData: Prisma.CommissionPayoutUncheckedUpdateInput = {
      updatedBy: opts.editedBy,
    };
    const auditRows: {
      fieldChanged: string;
      oldValue: Prisma.InputJsonValue;
      newValue: Prisma.InputJsonValue;
    }[] = [];

    for (const field of EDITABLE_FIELDS) {
      if (!Object.hasOwn(patch, field)) continue;
      const incoming = patch[field];
      const current = (existing as Record<string, unknown>)[field];
      const newNorm = normalizeForDiff(incoming);
      const oldNorm = normalizeForDiff(current);
      if (newNorm === oldNorm) continue;

      if (field === "lockedAt") {
        updateData.lockedAt = incoming as Date | null | undefined;
        // Lock transitions also stamp/clear lockedBy in the same write.
        updateData.lockedBy = incoming ? opts.editedBy : null;
      } else {
        (updateData as Record<string, unknown>)[field] = incoming;
      }
      auditRows.push({
        fieldChanged: field,
        oldValue: oldNorm as Prisma.InputJsonValue,
        newValue: newNorm as Prisma.InputJsonValue,
      });
    }

    if (auditRows.length === 0) {
      // No-op edit — caller submitted same values. Don't touch the row,
      // don't write audit. Operator can re-submit with actual changes.
      return { payoutId, editsRecorded: 0 };
    }

    await tx.commissionPayout.update({ where: { id: payoutId }, data: updateData });
    await tx.commissionPayoutEdit.createMany({
      data: auditRows.map((a) => ({
        payoutId,
        fieldChanged: a.fieldChanged,
        oldValue: a.oldValue,
        newValue: a.newValue,
        reason: opts.reason.trim(),
        editedBy: opts.editedBy,
      })),
    });

    return { payoutId, editsRecorded: auditRows.length };
  });
}

// Re-exports for the API layer + the UI types

export type { ComputedPayout } from "@/lib/commissionPayout";
export type { PayoutBreakdownEntry, TierDefinitionSnapshot } from "@/lib/commissionPayout";
