// /app/__tests__/lib/tax/resolveTaxRate.test.ts
//
// Pure unit tests for rateForLineAmount -- the part of resolveTaxRate.ts
// that used to be `take: 1`. No DB: resolveTaxDistrict's district-resolution
// order (customer exemption/override, store, AppSettings default, warn) is
// integration-tested against a real Prisma client in
// __tests__/integration/resolveTaxRate.integration.test.ts instead, since
// that logic IS the database query, not arithmetic on values already loaded.

import { lineTaxGroupOf, rateForLineAmount, type TaxDistrictRule } from "@/lib/tax/resolveTaxRate";

const STANDARD = 1;
const CLOTHING = 2;

function rule(
  overrides: Partial<TaxDistrictRule> & { id: number; taxRate: number },
): TaxDistrictRule {
  return {
    groupId: STANDARD,
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
  it("applies a flat rule (every band field null) regardless of amount -- the flat-rate seed shape", () => {
    const rules = [rule({ id: 1, taxRate: 0.065 })];
    expect(rateForLineAmount(rules, 1).rate).toBe(0.065);
    expect(rateForLineAmount(rules, 1_000_000).rate).toBe(0.065);
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

describe("rateForLineAmount with a line's tax group (GAP-04b)", () => {
  // A district taxing ordinary goods at 6% and clothing at 0% under $175,
  // 6% above -- clothing's rules sort after the standard one, so the old
  // group-blind walk would always have charged clothing 6%.
  const district = [
    rule({ id: 1, groupId: STANDARD, taxRate: 0.06, sortOrder: 0 }),
    rule({ id: 2, groupId: CLOTHING, taxRate: 0, stopPrice: 175, sortOrder: 1 }),
    rule({ id: 3, groupId: CLOTHING, taxRate: 0.06, startPrice: 175.01, sortOrder: 2 }),
  ];

  it("a group marked not taxed is 0% whatever the district's rules say", () => {
    expect(rateForLineAmount(district, 500, { id: 9, exempt: true })).toEqual({
      rate: 0,
      ruleId: null,
    });
  });

  it("a group with its own rules uses only those, bands included", () => {
    const clothing = { id: CLOTHING, exempt: false };
    expect(rateForLineAmount(district, 120, clothing)).toEqual({ rate: 0, ruleId: 2 });
    expect(rateForLineAmount(district, 300, clothing)).toEqual({ rate: 0.06, ruleId: 3 });
  });

  it("no group, or a taxed group the district has no rule for, reads every rule as before", () => {
    expect(rateForLineAmount(district, 120)).toEqual({ rate: 0.06, ruleId: 1 });
    expect(rateForLineAmount(district, 120, { id: 77, exempt: false })).toEqual({
      rate: 0.06,
      ruleId: 1,
    });
  });
});

describe("lineTaxGroupOf", () => {
  const standard = { id: STANDARD, exempt: false };
  const notTaxed = { id: 9, exempt: true };

  it("the product's own group wins over its category's", () => {
    expect(lineTaxGroupOf({ taxGroup: notTaxed, category: { taxGroup: standard } })).toBe(notTaxed);
  });

  it("falls back to the category's group, then to none", () => {
    expect(lineTaxGroupOf({ taxGroup: null, category: { taxGroup: notTaxed } })).toBe(notTaxed);
    expect(lineTaxGroupOf({ taxGroup: null, category: { taxGroup: null } })).toBeNull();
    expect(lineTaxGroupOf(null)).toBeNull();
  });
});
