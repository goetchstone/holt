// /app/src/lib/protectionPlanCommission.ts
//
// A commission plan of its own for protection plans (GAP-24, DECISIONS 56). Owner,
// 2026-11-10: "I think we need to be able to build a plan for the protection plans as a
// separate thing". Protection plans stay ordinary items; a store puts them in a category
// and builds a PROTECTION_PLAN commission plan for that category. Whether those sales
// also count toward a salesperson's main brackets is the store's choice ("this needs to
// be a configuration"), off by default.
//
// This file is the contract the commission screen and the plans endpoint share (rule 7):
// what a store sets up, how it is checked, and how it becomes one rule for the engine
// (lib/commissionRuleEngine.ts). It holds no database code, so the screen can import it.

import {
  validateRuleTiers,
  type RuleAccumulator,
  type RuleBasis,
  type RuleTierDef,
} from "@/lib/commissionRuleEngine";

/** A % of what the plan sold for, or a flat amount for each plan sold. */
export type ProtectionPlanPays = "PERCENT" | "PER_PLAN";
/** When the brackets start over: each January, or each pay period. */
export type ProtectionPlanResets = "YEAR" | "PAY_PERIOD";

export interface ProtectionPlanBracket {
  /** Where the bracket starts: dollars of protection plans sold (PERCENT), or plans sold (PER_PLAN). */
  from: number;
  /** A rate from 0 to 1 (PERCENT), or dollars per plan (PER_PLAN). */
  amount: number;
}

export interface ProtectionPlanSetup {
  name: string;
  description: string | null;
  /** The category the store's protection plans are in. */
  categoryId: number;
  pays: ProtectionPlanPays;
  resets: ProtectionPlanResets;
  /** Whether these sales also count, unpaid, toward the salesperson's main-plan brackets. */
  alsoCountsInMainPlan: boolean;
  brackets: ProtectionPlanBracket[];
}

/** The rule's label in a payout's breakdown. Fixed, so renaming the plan doesn't leave it stale. */
export const PROTECTION_PLAN_RULE_LABEL = "Protection plans";

const PAYS: readonly ProtectionPlanPays[] = ["PERCENT", "PER_PLAN"];
const RESETS: readonly ProtectionPlanResets[] = ["YEAR", "PAY_PERIOD"];

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseBrackets(
  raw: unknown,
  pays: ProtectionPlanPays,
): { ok: true; brackets: ProtectionPlanBracket[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "Give the plan at least one rate." };
  }
  const brackets: ProtectionPlanBracket[] = [];
  for (const [i, b] of raw.entries()) {
    const from = (b as { from?: unknown })?.from;
    const amount = (b as { amount?: unknown })?.amount;
    if (!isNumber(from) || from < 0) {
      return { ok: false, error: `Bracket ${i + 1}: where it starts must be 0 or more.` };
    }
    if (!isNumber(amount) || amount < 0) {
      return { ok: false, error: `Bracket ${i + 1}: the rate must be 0 or more.` };
    }
    if (pays === "PERCENT" && amount > 1) {
      return { ok: false, error: `Bracket ${i + 1}: a rate can't be more than 100%.` };
    }
    if (i > 0 && from <= brackets[i - 1].from) {
      return { ok: false, error: `Bracket ${i + 1} has to start above bracket ${i}.` };
    }
    brackets.push({ from, amount });
  }
  return { ok: true, brackets };
}

/** Check what the screen sent. Every field is required except the description. */
export function parseProtectionPlanSetup(
  body: unknown,
): { ok: true; setup: ProtectionPlanSetup } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Plan name is required." };
  if (typeof b.categoryId !== "number" || !Number.isInteger(b.categoryId) || b.categoryId < 1) {
    return { ok: false, error: "Choose the category your protection plans are in." };
  }
  if (!PAYS.includes(b.pays as ProtectionPlanPays)) {
    return { ok: false, error: "Choose whether the plan pays a percent or an amount per plan." };
  }
  if (!RESETS.includes(b.resets as ProtectionPlanResets)) {
    return { ok: false, error: "Choose when the brackets start over." };
  }
  if (typeof b.alsoCountsInMainPlan !== "boolean") {
    return { ok: false, error: "Say whether these sales also count toward the main plan." };
  }
  const pays = b.pays as ProtectionPlanPays;
  const parsed = parseBrackets(b.brackets, pays);
  if (!parsed.ok) return parsed;
  const setup: ProtectionPlanSetup = {
    name,
    description: typeof b.description === "string" && b.description.trim() ? b.description : null,
    categoryId: b.categoryId,
    pays,
    resets: b.resets as ProtectionPlanResets,
    alsoCountsInMainPlan: b.alsoCountsInMainPlan,
    brackets: parsed.brackets,
  };
  const tierError = validateRuleTiers(bracketsToTiers(setup));
  if (tierError) return { ok: false, error: tierError };
  return { ok: true, setup };
}

function bracketLabel(from: number, pays: ProtectionPlanPays): string {
  if (pays === "PER_PLAN") return from === 0 ? "From the first plan" : `After ${from} plans`;
  return `From $${from.toLocaleString("en-US")}`;
}

/** The engine's tiers: each bracket runs to where the next one starts, the last without end. */
export function bracketsToTiers(
  setup: Pick<ProtectionPlanSetup, "pays" | "brackets">,
): RuleTierDef[] {
  return setup.brackets.map((b, i) => ({
    label: bracketLabel(b.from, setup.pays),
    minAmount: b.from,
    maxAmountExclusive: i + 1 < setup.brackets.length ? setup.brackets[i + 1].from : null,
    rate: setup.pays === "PERCENT" ? b.amount : null,
    perUnitAmount: setup.pays === "PER_PLAN" ? b.amount : null,
    sortOrder: i,
  }));
}

/** The rule's basis and accumulator. A percent is of the price; an amount is per plan sold. */
export function ruleShape(setup: Pick<ProtectionPlanSetup, "pays" | "resets">): {
  basis: RuleBasis;
  accumulator: RuleAccumulator;
} {
  return {
    basis: setup.pays === "PERCENT" ? "REVENUE" : "UNITS",
    accumulator: setup.resets === "YEAR" ? "YTD" : "PERIOD",
  };
}

/** Read a stored rule back into what the screen edits. */
export function setupFromRule(rule: {
  basis: string;
  accumulator: string;
  tiers: Array<{ minAmount: number; rate: number | null; perUnitAmount: number | null }>;
}): Pick<ProtectionPlanSetup, "pays" | "resets" | "brackets"> {
  const pays: ProtectionPlanPays = rule.basis === "UNITS" ? "PER_PLAN" : "PERCENT";
  return {
    pays,
    resets: rule.accumulator === "YTD" ? "YEAR" : "PAY_PERIOD",
    brackets: rule.tiers.map((t) => ({
      from: t.minAmount,
      amount: (pays === "PERCENT" ? t.rate : t.perUnitAmount) ?? 0,
    })),
  };
}
