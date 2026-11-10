// /app/src/lib/commissionRules.ts
//
// DB-touching resolution layer for the Stage 1 commission rule engine
// (lib/commissionRuleEngine.ts, which is pure and never imports Prisma).
// Generalizes lib/commissionPlans.ts:resolvePlanTiersForStaff's chain to
// RULES:
//
//   1. the staff member's assigned plan's own CommissionPlanRule rows
//      (if it has any ACTIVE ones) -- authoritative once a plan has real
//      rules, which every plan does after the 20260801_commission_rule_engine
//      migration converts existing CommissionPlanTier sets.
//   2. else the assigned plan's CommissionPlanTier rows, DERIVED on the fly
//      into an equivalent scope-all/REVENUE/YTD/MARGINAL rule
//      (deriveRuleFromLegacyTiers) -- covers a plan created or edited via
//      the pre-Stage-1 flat-tier API (createPlan/replacePlanTiers) that
//      never got real rule rows. Deriving at READ time (rather than
//      writing a synced copy on every tier edit) means the old tier editor
//      needs zero changes and can never drift out of sync with a stale
//      persisted mirror -- rule 6/7's "don't duplicate, and don't invent a
//      second source of truth that can disagree with the first" concern.
//   3. else the same two-step lookup against the isDefault plan.
//   4. else the legacy global CommissionTier table, derived.
//   5. else no rule at all — an unconfigured deployment earns no commission.
//
// Steps 4+5 are exactly loadLegacyOrDefaultTiers' behavior, generalized: it
// used to end in DEFAULT_COMMISSION_TIERS and now ends in an empty set.
//
// Protection plans (GAP-24, DECISIONS 56). A PROTECTION_PLAN plan is resolved
// the same way on its own track: the person's assigned one, else that kind's
// default, else none. Its rules go AHEAD of the main plan's, so first-match-
// wins hands its category's sales to it and everything else to the main plan.
// With none, protection plans pay under the main plan like any other sale.

import { prisma } from "@/lib/prisma";
import type { CommissionCountsWhen } from "@prisma/client";
import { loadLegacyOrDefaultTiers, type TierInput } from "@/lib/commissionPlans";
import {
  deriveRuleFromLegacyTiers,
  validateRuleTiers,
  LEGACY_RULE_KEY,
  LEGACY_RULE_LABEL,
  type CommissionRuleDef,
  type RuleScope,
} from "@/lib/commissionRuleEngine";

export interface ResolvedPlanRules {
  /** NULL when resolved from the legacy table or built-in defaults. */
  planId: number | null;
  planName: string;
  /** The protection-plan plan whose rules lead `rules`, or null. */
  protectionPlanName: string | null;
  /** The main plan's: a protection-plan plan follows the main plan's choice. */
  countsWhen: CommissionCountsWhen;
  rules: CommissionRuleDef[];
}

/**
 * A protection-plan plan's rule must name what it covers. One with no scope at
 * all would claim every sale ahead of the main plan, so it is left out: fail
 * closed, and the plans endpoint refuses to save one.
 */
export function hasScope(r: {
  departmentId: number | null;
  categoryId: number | null;
  vendorId: number | null;
  storeLocationId: number | null;
  productTypeId: number | null;
}): boolean {
  return [r.departmentId, r.categoryId, r.vendorId, r.storeLocationId, r.productTypeId].some(
    (v) => v !== null,
  );
}

/** The person's protection-plan rules, then their main plan's, in that order. */
function withProtectionPlan(
  main: ResolvedPlanRules,
  protection: { name: string; rules: CommissionRuleDef[] } | null,
): ResolvedPlanRules {
  if (!protection || protection.rules.length === 0) return main;
  return {
    ...main,
    protectionPlanName: protection.name,
    rules: [...protection.rules, ...main.rules].map((r, i) => ({ ...r, sortOrder: i })),
  };
}

interface DecimalLike {
  toString(): string;
}

interface DbRuleTierRow {
  label: string;
  minAmount: DecimalLike;
  maxAmountExclusive: DecimalLike | null;
  rate: DecimalLike | null;
  perUnitAmount: DecimalLike | null;
  sortOrder: number;
}

interface DbRuleRow {
  id: number;
  label: string;
  sortOrder: number;
  isActive: boolean;
  departmentId: number | null;
  categoryId: number | null;
  vendorId: number | null;
  storeLocationId: number | null;
  productTypeId: number | null;
  basis: string;
  accumulator: string;
  tierMode: string;
  tiers: DbRuleTierRow[];
}

type NameMaps = {
  department: Map<number, string>;
  category: Map<number, string>;
  vendor: Map<number, string>;
  storeLocation: Map<number, string>;
  productType: Map<number, string>;
};

function describeScope(row: DbRuleRow, names: NameMaps): { scope: RuleScope; description: string } {
  const scope: RuleScope = {
    departmentId: row.departmentId,
    categoryId: row.categoryId,
    vendorId: row.vendorId,
    storeLocationId: row.storeLocationId,
    productTypeId: row.productTypeId,
  };
  const parts: string[] = [];
  if (row.departmentId != null) {
    parts.push(`Department: ${names.department.get(row.departmentId) ?? `#${row.departmentId}`}`);
  }
  if (row.categoryId != null) {
    parts.push(`Category: ${names.category.get(row.categoryId) ?? `#${row.categoryId}`}`);
  }
  if (row.vendorId != null) {
    parts.push(`Vendor: ${names.vendor.get(row.vendorId) ?? `#${row.vendorId}`}`);
  }
  if (row.storeLocationId != null) {
    parts.push(
      `Store: ${names.storeLocation.get(row.storeLocationId) ?? `#${row.storeLocationId}`}`,
    );
  }
  if (row.productTypeId != null) {
    parts.push(
      `Product type: ${names.productType.get(row.productTypeId) ?? `#${row.productTypeId}`}`,
    );
  }
  return { scope, description: parts.length > 0 ? parts.join(", ") : "All sales" };
}

function dbRuleToDef(row: DbRuleRow, names: NameMaps): CommissionRuleDef {
  const { scope, description } = describeScope(row, names);
  return {
    id: row.id,
    ruleKey: `id:${row.id}`,
    label: row.label,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    scope,
    scopeDescription: description,
    basis: row.basis as CommissionRuleDef["basis"],
    accumulator: row.accumulator as CommissionRuleDef["accumulator"],
    tierMode: row.tierMode as CommissionRuleDef["tierMode"],
    tiers: row.tiers
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => ({
        label: t.label,
        minAmount: Number(t.minAmount),
        maxAmountExclusive: t.maxAmountExclusive === null ? null : Number(t.maxAmountExclusive),
        rate: t.rate === null ? null : Number(t.rate),
        perUnitAmount: t.perUnitAmount === null ? null : Number(t.perUnitAmount),
        sortOrder: t.sortOrder,
      })),
  };
}

/** Distinct, non-null ids for one scope dimension across every rule row. */
function collectScopeIds(
  rows: DbRuleRow[],
  field: keyof Pick<
    DbRuleRow,
    "departmentId" | "categoryId" | "vendorId" | "storeLocationId" | "productTypeId"
  >,
): number[] {
  const ids = new Set<number>();
  for (const r of rows) {
    const value = r[field];
    if (value != null) ids.add(value);
  }
  return [...ids];
}

function toNameMap(rows: Array<{ id: number; name: string }>): Map<number, string> {
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadNameMaps(rows: DbRuleRow[]): Promise<NameMaps> {
  const deptIds = collectScopeIds(rows, "departmentId");
  const catIds = collectScopeIds(rows, "categoryId");
  const vendorIds = collectScopeIds(rows, "vendorId");
  const storeIds = collectScopeIds(rows, "storeLocationId");
  const typeIds = collectScopeIds(rows, "productTypeId");

  const [departments, categories, vendors, stores, types] = await Promise.all([
    deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } } }) : [],
    catIds.length ? prisma.category.findMany({ where: { id: { in: catIds } } }) : [],
    vendorIds.length ? prisma.vendor.findMany({ where: { id: { in: vendorIds } } }) : [],
    storeIds.length ? prisma.storeLocation.findMany({ where: { id: { in: storeIds } } }) : [],
    typeIds.length ? prisma.type.findMany({ where: { id: { in: typeIds } } }) : [],
  ]);
  return {
    department: toNameMap(departments),
    category: toNameMap(categories),
    vendor: toNameMap(vendors),
    storeLocation: toNameMap(stores),
    productType: toNameMap(types),
  };
}

function tierInputToLegacyRow(t: TierInput) {
  return {
    label: t.label,
    minYtdSales: t.minYtdSales,
    maxYtdSalesExclusive: t.maxYtdSalesExclusive,
    rate: t.rate,
    sortOrder: t.sortOrder,
  };
}

/**
 * Resolve the rule set for each staff member in one pass. Used by payout
 * preview/commit so every surface prices a designer by the same rules.
 */
export async function resolvePlanRulesForStaff(
  staffIds: number[],
): Promise<Map<number, ResolvedPlanRules>> {
  const out = new Map<number, ResolvedPlanRules>();
  if (staffIds.length === 0) return out;

  const [staff, plans, fallback] = await Promise.all([
    prisma.staffMember.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, commissionPlanId: true, protectionCommissionPlanId: true },
    }),
    prisma.commissionPlan.findMany({
      where: { isActive: true },
      include: {
        rules: {
          include: { tiers: { orderBy: { sortOrder: "asc" } } },
          orderBy: { sortOrder: "asc" },
        },
        tiers: { orderBy: { sortOrder: "asc" } },
      },
    }),
    loadLegacyOrDefaultTiers(),
  ]);

  const allRuleRows = plans.flatMap((p) => p.rules) as unknown as DbRuleRow[];
  const names = await loadNameMaps(allRuleRows);

  const mainPlans = plans.filter((p) => p.kind === "MAIN");
  const protectionPlans = plans.filter((p) => p.kind === "PROTECTION_PLAN");
  const byPlanId = new Map(mainPlans.map((p) => [p.id, p]));
  const defaultPlan = mainPlans.find((p) => p.isDefault) ?? null;
  const protectionById = new Map(protectionPlans.map((p) => [p.id, p]));
  const defaultProtection = protectionPlans.find((p) => p.isDefault) ?? null;
  const protectionRules = (plan: NonNullable<typeof defaultProtection>) => ({
    name: plan.name,
    rules: (plan.rules as unknown as DbRuleRow[])
      .filter((r) => r.isActive && hasScope(r))
      .map((r) => ({
        ...dbRuleToDef(r, names),
        alsoCountsTowardNextRule: plan.alsoCountsInMainPlan,
      })),
  });
  const legacyFallbackRules: CommissionRuleDef[] = [
    deriveRuleFromLegacyTiers(fallback.tiers.map(tierInputToLegacyRow)),
  ];

  const toResolved = (plan: NonNullable<typeof defaultPlan>): ResolvedPlanRules => {
    const activeRules = (plan.rules as unknown as DbRuleRow[]).filter((r) => r.isActive);
    let rules: CommissionRuleDef[];
    if (activeRules.length > 0) {
      rules = activeRules.map((r) => dbRuleToDef(r, names));
    } else if (plan.tiers.length > 0) {
      rules = [
        deriveRuleFromLegacyTiers(
          plan.tiers.map((t) => ({
            label: t.label,
            minYtdSales: Number(t.minYtdSales),
            maxYtdSalesExclusive:
              t.maxYtdSalesExclusive === null ? null : Number(t.maxYtdSalesExclusive),
            rate: Number(t.rate),
            sortOrder: t.sortOrder,
          })),
          { ruleKey: `plan-tiers:${plan.id}`, label: `${plan.name} (legacy tiers)` },
        ),
      ];
    } else {
      rules = legacyFallbackRules;
    }
    return {
      planId: plan.id,
      planName: plan.name,
      protectionPlanName: null,
      countsWhen: plan.countsWhen,
      rules,
    };
  };

  const legacyFallback: ResolvedPlanRules = {
    planId: null,
    planName: fallback.planName,
    protectionPlanName: null,
    countsWhen: "WRITTEN" as CommissionCountsWhen,
    rules: legacyFallbackRules,
  };

  for (const s of staff) {
    const assigned = s.commissionPlanId !== null ? byPlanId.get(s.commissionPlanId) : undefined;
    let main: ResolvedPlanRules;
    if (assigned) main = toResolved(assigned);
    else if (defaultPlan) main = toResolved(defaultPlan);
    else main = legacyFallback;

    const protection =
      (s.protectionCommissionPlanId !== null
        ? protectionById.get(s.protectionCommissionPlanId)
        : undefined) ?? defaultProtection;
    out.set(s.id, withProtectionPlan(main, protection ? protectionRules(protection) : null));
  }
  return out;
}

export { validateRuleTiers, LEGACY_RULE_KEY, LEGACY_RULE_LABEL };
