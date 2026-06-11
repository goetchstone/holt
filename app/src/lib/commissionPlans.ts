// /app/src/lib/commissionPlans.ts
//
// Per-salesperson commission plans. A plan is a named set of marginal YTD
// tiers in the exact CommissionTier row shape, so calculateMarginalCommission
// works unchanged with a plan's tiers passed where the single global set used
// to go.
//
// Tier resolution chain (the compatibility contract):
//   1. the staff member's assigned plan (StaffMember.commissionPlanId)
//   2. the isDefault plan
//   3. the legacy CommissionTier table  — a restored legacy backup lands its
//      tier rows here and computes IDENTICALLY until plans are created
//   4. DEFAULT_COMMISSION_TIERS          — fresh dev DB / first boot
// Steps 3+4 are exactly the old loadTiers() behavior.

import { prisma } from "@/lib/prisma";
import { DEFAULT_COMMISSION_TIERS, type CommissionTier } from "@/lib/commissionTiers";

export interface PlanTier extends CommissionTier {
  sortOrder: number;
}

export interface ResolvedPlanTiers {
  /** NULL when resolved from the legacy table or built-in defaults. */
  planId: number | null;
  planName: string;
  tiers: ReadonlyArray<PlanTier>;
}

export interface TierInput {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
  sortOrder: number;
}

/** Name shown when no plan row exists and the legacy/default chain resolved. */
export const LEGACY_PLAN_NAME = "Standard";

interface DecimalLike {
  toString(): string;
}

interface DbTierRow {
  label: string;
  minYtdSales: DecimalLike;
  maxYtdSalesExclusive: DecimalLike | null;
  rate: DecimalLike;
  sortOrder: number;
}

function dbTierToHelper(row: DbTierRow): PlanTier {
  return {
    label: row.label,
    minYtdSales: Number(row.minYtdSales),
    maxYtdSalesExclusive:
      row.maxYtdSalesExclusive === null ? null : Number(row.maxYtdSalesExclusive),
    rate: Number(row.rate),
    sortOrder: row.sortOrder,
  };
}

/**
 * The fallback tiers used when a staff member has no assigned plan and no
 * default plan exists: the legacy CommissionTier table, else the built-in
 * defaults. This IS the pre-plans loadTiers() behavior, preserved so a
 * restored legacy dataset keeps computing identical payouts.
 */
export async function loadLegacyOrDefaultTiers(): Promise<ResolvedPlanTiers> {
  const dbTiers = await prisma.commissionTier.findMany({ orderBy: { sortOrder: "asc" } });
  if (dbTiers.length > 0) {
    return {
      planId: null,
      planName: LEGACY_PLAN_NAME,
      tiers: dbTiers.map((t) => dbTierToHelper(t as unknown as DbTierRow)),
    };
  }
  return {
    planId: null,
    planName: LEGACY_PLAN_NAME,
    tiers: DEFAULT_COMMISSION_TIERS.map((t, i) => ({ ...t, sortOrder: i })),
  };
}

/**
 * Resolve the tier set for each staff member in one pass. Used by payout
 * preview/commit and the live calculator so every surface prices a designer
 * by the same plan.
 */
export async function resolvePlanTiersForStaff(
  staffIds: number[],
): Promise<Map<number, ResolvedPlanTiers>> {
  const out = new Map<number, ResolvedPlanTiers>();
  if (staffIds.length === 0) return out;

  const [staff, plans, fallback] = await Promise.all([
    prisma.staffMember.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, commissionPlanId: true },
    }),
    prisma.commissionPlan.findMany({
      where: { isActive: true },
      include: { tiers: { orderBy: { sortOrder: "asc" } } },
    }),
    loadLegacyOrDefaultTiers(),
  ]);

  const byPlanId = new Map(plans.map((p) => [p.id, p]));
  const defaultPlan = plans.find((p) => p.isDefault) ?? null;

  const toResolved = (plan: NonNullable<typeof defaultPlan>): ResolvedPlanTiers => ({
    planId: plan.id,
    planName: plan.name,
    tiers: plan.tiers.map((t) => dbTierToHelper(t as unknown as DbTierRow)),
  });

  for (const s of staff) {
    const assigned = s.commissionPlanId !== null ? byPlanId.get(s.commissionPlanId) : undefined;
    if (assigned && assigned.tiers.length > 0) {
      out.set(s.id, toResolved(assigned));
    } else if (defaultPlan && defaultPlan.tiers.length > 0) {
      out.set(s.id, toResolved(defaultPlan));
    } else {
      out.set(s.id, fallback);
    }
  }
  return out;
}

/**
 * Bracket validation shared by the plans endpoint and tests: label present,
 * rate in [0,1], minYtdSales >= 0, brackets contiguous + ascending, only the
 * LAST tier may be unbounded (maxYtdSalesExclusive = null). Returns an error
 * message or null. Identical rules to the original whole-set tier editor.
 */
export function validatePlanTiers(tiers: TierInput[]): string | null {
  if (tiers.length === 0) return "A plan needs at least one tier";
  for (const [i, t] of tiers.entries()) {
    const fieldError = validateTierFields(t, i);
    if (fieldError) return fieldError;
    const bracketError = validateTierBrackets(t, i, tiers);
    if (bracketError) return bracketError;
  }
  return null;
}

function validateTierFields(t: TierInput, i: number): string | null {
  if (!t.label || typeof t.label !== "string") return `Tier ${i + 1}: missing label`;
  if (typeof t.rate !== "number" || t.rate < 0 || t.rate > 1) {
    return `Tier ${i + 1} (${t.label}): rate must be between 0 and 1`;
  }
  if (typeof t.minYtdSales !== "number" || t.minYtdSales < 0) {
    return `Tier ${i + 1} (${t.label}): minYtdSales must be >= 0`;
  }
  return null;
}

function validateTierBrackets(t: TierInput, i: number, tiers: TierInput[]): string | null {
  const isLast = i === tiers.length - 1;
  if (isLast) {
    if (t.maxYtdSalesExclusive !== null && t.maxYtdSalesExclusive <= t.minYtdSales) {
      return `Tier ${i + 1} (${t.label}): maxYtdSalesExclusive must be > minYtdSales`;
    }
    return null;
  }
  if (t.maxYtdSalesExclusive === null) {
    return `Tier ${i + 1} (${t.label}): only the last tier may be unbounded`;
  }
  if (t.maxYtdSalesExclusive <= t.minYtdSales) {
    return `Tier ${i + 1} (${t.label}): maxYtdSalesExclusive must be > minYtdSales`;
  }
  if (tiers[i + 1].minYtdSales !== t.maxYtdSalesExclusive) {
    return `Tiers ${i + 1} → ${i + 2}: brackets must be contiguous`;
  }
  return null;
}

/**
 * Replace a plan's tier set transactionally (the whole-set PUT idiom the
 * tier editor has always used — the set is small).
 */
export async function replacePlanTiers(
  planId: number,
  tiers: TierInput[],
  updatedBy?: string | null,
): Promise<void> {
  const error = validatePlanTiers(tiers);
  if (error) throw new PlanValidationError(error);
  await prisma.$transaction(async (tx) => {
    const plan = await tx.commissionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new PlanValidationError("Plan not found");
    await tx.commissionPlanTier.deleteMany({ where: { planId } });
    for (const [i, t] of tiers.entries()) {
      await tx.commissionPlanTier.create({
        data: {
          planId,
          label: t.label,
          minYtdSales: t.minYtdSales,
          maxYtdSalesExclusive: t.maxYtdSalesExclusive,
          rate: t.rate,
          sortOrder: t.sortOrder ?? i,
        },
      });
    }
    await tx.commissionPlan.update({
      where: { id: planId },
      data: { updatedBy: updatedBy ?? null },
    });
  });
}

export class PlanValidationError extends Error {}

/**
 * Create a plan. The FIRST plan created becomes the default automatically
 * (so the moment plans exist, the resolution chain has a step-2 answer);
 * its initial tiers are the current fallback set unless tiers are given —
 * which makes "convert the legacy tiers into a plan" a one-click create.
 */
export async function createPlan(input: {
  name: string;
  description?: string | null;
  tiers?: TierInput[];
  createdBy?: string | null;
}): Promise<{ id: number }> {
  const name = input.name?.trim();
  if (!name) throw new PlanValidationError("Plan name is required");

  let tiers = input.tiers;
  if (!tiers || tiers.length === 0) {
    const fallback = await loadLegacyOrDefaultTiers();
    tiers = fallback.tiers.map((t) => ({ ...t }));
  }
  const error = validatePlanTiers(tiers);
  if (error) throw new PlanValidationError(error);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.commissionPlan.count();
    const plan = await tx.commissionPlan.create({
      data: {
        name,
        description: input.description ?? null,
        isDefault: existing === 0,
        createdBy: input.createdBy ?? null,
      },
    });
    for (const [i, t] of tiers.entries()) {
      await tx.commissionPlanTier.create({
        data: {
          planId: plan.id,
          label: t.label,
          minYtdSales: t.minYtdSales,
          maxYtdSalesExclusive: t.maxYtdSalesExclusive,
          rate: t.rate,
          sortOrder: t.sortOrder ?? i,
        },
      });
    }
    return { id: plan.id };
  });
}

/** Make a plan the default (exactly one default at a time). */
export async function setDefaultPlan(planId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const plan = await tx.commissionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new PlanValidationError("Plan not found");
    await tx.commissionPlan.updateMany({ data: { isDefault: false } });
    await tx.commissionPlan.update({ where: { id: planId }, data: { isDefault: true } });
  });
}

/**
 * Delete a plan. Refuses while staff are assigned to it or it is the default
 * — reassign first. Historical payouts keep rendering via the denormalized
 * commissionPlanName (the FK nulls).
 */
export async function deletePlan(planId: number): Promise<void> {
  const [assigned, plan] = await Promise.all([
    prisma.staffMember.count({ where: { commissionPlanId: planId } }),
    prisma.commissionPlan.findUnique({ where: { id: planId } }),
  ]);
  if (!plan) throw new PlanValidationError("Plan not found");
  if (plan.isDefault) throw new PlanValidationError("Make another plan the default first");
  if (assigned > 0) {
    throw new PlanValidationError(
      `${assigned} staff member(s) are assigned to this plan — reassign them first`,
    );
  }
  await prisma.commissionPlan.delete({ where: { id: planId } });
}

/** List plans with tiers + assignment counts for the admin UI. */
export async function listPlans() {
  const plans = await prisma.commissionPlan.findMany({
    include: {
      tiers: { orderBy: { sortOrder: "asc" } },
      _count: { select: { staffMembers: true } },
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isDefault: p.isDefault,
    isActive: p.isActive,
    assignedCount: p._count.staffMembers,
    tiers: p.tiers.map((t) => ({
      label: t.label,
      minYtdSales: Number(t.minYtdSales),
      maxYtdSalesExclusive: t.maxYtdSalesExclusive === null ? null : Number(t.maxYtdSalesExclusive),
      rate: Number(t.rate),
      sortOrder: t.sortOrder,
    })),
  }));
}
