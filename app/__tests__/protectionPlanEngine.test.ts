// /app/__tests__/protectionPlanEngine.test.ts
//
// The engine side of protection-plan commission plans (GAP-24, DECISIONS 56): a
// protection-plan rule ahead of the main plan's rules pays its category's sales, and when
// the store chooses, those sales also count toward the main plan's brackets without being
// paid there (`alsoCountsTowardNextRule`). Pure data in, data out; the real-DB side is
// __tests__/integration/protectionPlanCommission.integration.test.ts.

import {
  computeRuleEnginePayout,
  type CommissionRuleDef,
  type CommissionSaleRow,
  type EngineInput,
  type RuleTierDef,
} from "../src/lib/commissionRuleEngine";

const PP_CATEGORY = 9;
const FURNITURE = 1;
const IN_PERIOD = new Date("2026-05-20T00:00:00Z");
const BEFORE_PERIOD = new Date("2026-03-15T00:00:00Z");

function row(
  revenue: number,
  categoryId: number,
  opts: { at?: Date; transactionId?: number } = {},
): CommissionSaleRow {
  return {
    transactionId: opts.transactionId ?? Math.random(),
    occurredAt: opts.at ?? IN_PERIOD,
    revenue,
    margin: revenue,
    units: 1,
    departmentId: null,
    categoryId,
    vendorId: null,
    storeLocationId: null,
    productTypeId: null,
  };
}

function tier(label: string, min: number, max: number | null, rate: number): RuleTierDef {
  return {
    label,
    minAmount: min,
    maxAmountExclusive: max,
    rate,
    perUnitAmount: null,
    sortOrder: min,
  };
}

/** 10% of every protection plan, ahead of the main plan. */
function ppRule(alsoCounts: boolean): CommissionRuleDef {
  return {
    id: 1,
    ruleKey: "pp",
    label: "Protection plans",
    sortOrder: 0,
    isActive: true,
    scope: { categoryId: PP_CATEGORY },
    scopeDescription: "Category: Protection Plans",
    basis: "REVENUE",
    accumulator: "YTD",
    tierMode: "MARGINAL",
    tiers: [tier("From $0", 0, null, 0.1)],
    alsoCountsTowardNextRule: alsoCounts,
  };
}

/** 3% up to $10,000 of the year's sales, 5% after. */
function mainRule(overrides: Partial<CommissionRuleDef> = {}): CommissionRuleDef {
  return {
    id: 2,
    ruleKey: "main",
    label: "All sales",
    sortOrder: 1,
    isActive: true,
    scope: {},
    scopeDescription: "All sales",
    basis: "REVENUE",
    accumulator: "YTD",
    tierMode: "MARGINAL",
    tiers: [tier("Base", 0, 10_000, 0.03), tier("Top", 10_000, null, 0.05)],
    ...overrides,
  };
}

function run(rules: CommissionRuleDef[], saleRows: CommissionSaleRow[]) {
  const input: EngineInput = {
    rules,
    saleRows,
    periodStart: new Date("2026-05-16T00:00:00Z"),
    periodEndExclusive: new Date("2026-06-01T00:00:00Z"),
    yearStart: new Date("2026-01-01T00:00:00Z"),
    priorState: [],
  };
  return computeRuleEnginePayout(input);
}

const paidBy = (result: ReturnType<typeof run>, ruleKey: string) =>
  result.breakdown
    .filter((e) => e.ruleKey === ruleKey)
    .reduce((sum, e) => Math.round((sum + e.sliceCommission) * 100) / 100, 0);
const positionOf = (result: ReturnType<typeof run>, ruleKey: string) =>
  result.nextState.find((s) => s.ruleKey === ruleKey)?.basisAtEnd;

describe("a protection-plan rule ahead of the main plan", () => {
  const sales = [row(8_000, FURNITURE), row(4_000, PP_CATEGORY)];

  it("pays its category and leaves the main plan the rest (not counted toward its brackets)", () => {
    const result = run([ppRule(false), mainRule()], sales);
    expect(paidBy(result, "pp")).toBe(400);
    expect(paidBy(result, "main")).toBe(240); // $8,000 at 3%: still under the $10,000 bracket
    expect(positionOf(result, "main")).toBe(8_000);
    expect(result.commissionAmount).toBe(640);
  });

  it("counted toward the main brackets: everything moves the position, the main plan pays its own share", () => {
    const result = run([ppRule(true), mainRule()], sales);
    // The protection plan is still paid once, by its own plan.
    expect(paidBy(result, "pp")).toBe(400);
    // Position $0 -> $12,000: $10,000 at 3% + $2,000 at 5% = $400 for the window, of which
    // the furniture is $8,000 / $12,000.
    expect(paidBy(result, "main")).toBe(266.67);
    expect(positionOf(result, "main")).toBe(12_000);
    expect(result.commissionAmount).toBe(666.67);
  });

  it("protection plans sold earlier in the year put this period's furniture in the higher bracket", () => {
    const earlier = [row(10_000, PP_CATEGORY, { at: BEFORE_PERIOD }), row(5_000, FURNITURE)];
    expect(paidBy(run([ppRule(true), mainRule()], earlier), "main")).toBe(250); // all at 5%
    expect(paidBy(run([ppRule(false), mainRule()], earlier), "main")).toBe(150); // all at 3%
  });

  it("with no protection plans sold, the flag changes nothing", () => {
    const furnitureOnly = [row(6_000, FURNITURE), row(7_000, FURNITURE, { at: BEFORE_PERIOD })];
    const withFlag = run([ppRule(true), mainRule()], furnitureOnly);
    const mainAlone = run([mainRule()], furnitureOnly);
    expect(withFlag.commissionAmount).toBe(mainAlone.commissionAmount);
    expect(withFlag.breakdown).toEqual(mainAlone.breakdown);
  });

  it("a furniture return in the window is never paid out of protection-plan sales", () => {
    const result = run(
      [ppRule(true), mainRule({ tiers: [tier("Flat", 0, null, 0.05)] })],
      [row(-1_000, FURNITURE), row(3_000, PP_CATEGORY)],
    );
    expect(paidBy(result, "main")).toBe(0);
    expect(result.breakdown.filter((e) => e.ruleKey === "main")).toEqual([]);
    expect(paidBy(result, "pp")).toBe(300);
  });

  it("RETROACTIVE: the band everything reached re-rates only the main plan's own sales", () => {
    const retro = mainRule({ tierMode: "RETROACTIVE" });
    expect(paidBy(run([ppRule(true), retro], sales), "main")).toBe(400); // 5% of $8,000
    expect(paidBy(run([ppRule(false), retro], sales), "main")).toBe(240); // 3% of $8,000
  });

  it("PER_TRANSACTION: a protection plan on the same sale moves that sale's window", () => {
    const perSale = mainRule({
      accumulator: "PER_TRANSACTION",
      tiers: [tier("Under goal", 0, 5_000, 0), tier("Over goal", 5_000, null, 0.1)],
    });
    const oneSale = [
      row(4_000, FURNITURE, { transactionId: 7 }),
      row(2_000, PP_CATEGORY, { transactionId: 7 }),
    ];
    // Window [0, $6,000): $1,000 over the goal at 10% = $100, the furniture's share 4/6.
    expect(paidBy(run([ppRule(true), perSale], oneSale), "main")).toBe(66.67);
    expect(paidBy(run([ppRule(false), perSale], oneSale), "main")).toBe(0);

    // RETROACTIVE per sale: the sale reached the 10% band, which re-rates only the furniture.
    const perSaleRetro = { ...perSale, tierMode: "RETROACTIVE" as const };
    expect(paidBy(run([ppRule(true), perSaleRetro], oneSale), "main")).toBe(400);
    expect(paidBy(run([ppRule(false), perSaleRetro], oneSale), "main")).toBe(0);
  });

  it("counted rows go only to the next rule that matches them", () => {
    const vendorRule = mainRule({
      ruleKey: "vendor",
      sortOrder: 1,
      scope: { vendorId: 99 },
      tiers: [tier("Flat", 0, null, 0.5)],
    });
    const result = run(
      [ppRule(true), vendorRule, mainRule({ sortOrder: 2 })],
      [row(8_000, FURNITURE), row(4_000, PP_CATEGORY)],
    );
    expect(positionOf(result, "vendor")).toBe(0);
    expect(positionOf(result, "main")).toBe(12_000);
  });
});
