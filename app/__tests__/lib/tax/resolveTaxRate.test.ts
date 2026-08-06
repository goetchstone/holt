// /app/__tests__/lib/tax/resolveTaxRate.test.ts
//
// Pure unit tests for rateForLineAmount -- the part of resolveTaxRate.ts
// that used to be `take: 1`. No DB: resolveTaxDistrict's district-resolution
// order (customer exemption/override, store, AppSettings default, warn) is
// integration-tested against a real Prisma client in
// __tests__/integration/resolveTaxRate.integration.test.ts instead, since
// that logic IS the database query, not arithmetic on values already loaded.

import { rateForLineAmount, type TaxDistrictRule } from "@/lib/tax/resolveTaxRate";

function rule(
  overrides: Partial<TaxDistrictRule> & { id: number; taxRate: number },
): TaxDistrictRule {
  return {
    triggerPrice: null,
    triggerStop: null,
    startPrice: null,
    stopPrice: null,
    taxIncludedInSalesPrice: false,
    ruleToAddBeforeCalcId: null,
    sortOrder: 0,
    ...overrides,
  };
}

describe("rateForLineAmount", () => {
  it("applies a flat rule (every band field null) regardless of amount -- the CT seed shape", () => {
    const rules = [rule({ id: 1, taxRate: 0.0635 })];
    expect(rateForLineAmount(rules, 1).rate).toBe(0.0635);
    expect(rateForLineAmount(rules, 1_000_000).rate).toBe(0.0635);
  });

  it("returns rate 0 with no matching rule id when the district has no rules", () => {
    expect(rateForLineAmount([], 500)).toEqual({ rate: 0, ruleId: null });
  });

  it("gates on triggerPrice -- a rule below its minimum does not apply", () => {
    const rules = [rule({ id: 1, taxRate: 0.05, triggerPrice: 100 })];
    expect(rateForLineAmount(rules, 99.99)).toEqual({ rate: 0, ruleId: null });
    expect(rateForLineAmount(rules, 100).rate).toBe(0.05);
    expect(rateForLineAmount(rules, 500).rate).toBe(0.05);
  });

  it("gates on triggerStop -- a rule above its maximum does not apply", () => {
    const rules = [rule({ id: 1, taxRate: 0.05, triggerStop: 200 })];
    expect(rateForLineAmount(rules, 200).rate).toBe(0.05);
    expect(rateForLineAmount(rules, 200.01)).toEqual({ rate: 0, ruleId: null });
  });

  it("gates on the startPrice/stopPrice band the same way triggerPrice/triggerStop do", () => {
    const rules = [rule({ id: 1, taxRate: 0.08, startPrice: 175, stopPrice: 500 })];
    expect(rateForLineAmount(rules, 174.99)).toEqual({ rate: 0, ruleId: null });
    expect(rateForLineAmount(rules, 175).rate).toBe(0.08);
    expect(rateForLineAmount(rules, 500).rate).toBe(0.08);
    expect(rateForLineAmount(rules, 500.01)).toEqual({ rate: 0, ruleId: null });
  });

  it("tries rules in sortOrder and picks the first one whose bands admit the amount", () => {
    // A classic two-tier schedule: exempt under $175, taxed at 6.25% above.
    const rules = [
      rule({ id: 1, taxRate: 0, stopPrice: 174.99, sortOrder: 0 }),
      rule({ id: 2, taxRate: 0.0625, startPrice: 175, sortOrder: 1 }),
    ];
    expect(rateForLineAmount(rules, 100)).toEqual({ rate: 0, ruleId: 1 });
    expect(rateForLineAmount(rules, 175)).toEqual({ rate: 0.0625, ruleId: 2 });
  });

  it("input order (not numeric order) decides priority -- callers must pre-sort by sortOrder", () => {
    // Two rules that could both admit the same amount; whichever is FIRST
    // in the array wins, mirroring the old `take: 1` behaviour of "lowest
    // sortOrder wins" once resolveTaxDistrict has already sorted them.
    const rules = [
      rule({ id: 1, taxRate: 0.01, sortOrder: 0 }),
      rule({ id: 2, taxRate: 0.99, sortOrder: 1 }),
    ];
    expect(rateForLineAmount(rules, 50)).toEqual({ rate: 0.01, ruleId: 1 });
  });

  it("a zero-amount line can still be gated out by a positive triggerPrice", () => {
    const rules = [rule({ id: 1, taxRate: 0.05, triggerPrice: 0.01 })];
    expect(rateForLineAmount(rules, 0)).toEqual({ rate: 0, ruleId: null });
  });
});
