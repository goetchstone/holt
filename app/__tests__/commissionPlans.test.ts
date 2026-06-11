// /app/__tests__/commissionPlans.test.ts
//
// Pure-helper coverage for validatePlanTiers — the bracket validation
// shared by the plans endpoint and replacePlanTiers/createPlan. Pins
// every rule: label required, rate in [0,1], min >= 0, only the last
// tier may be unbounded, max > min, contiguous brackets, non-empty set.

import { validatePlanTiers, type TierInput } from "@/lib/commissionPlans";

function tier(overrides: Partial<TierInput> = {}): TierInput {
  return {
    label: "Tier",
    minYtdSales: 0,
    maxYtdSalesExclusive: null,
    rate: 0.03,
    sortOrder: 0,
    ...overrides,
  };
}

describe("validatePlanTiers", () => {
  it("rejects an empty tier set", () => {
    expect(validatePlanTiers([])).toBe("A plan needs at least one tier");
  });

  it("accepts a single unbounded tier (flat plan)", () => {
    expect(validatePlanTiers([tier({ label: "Flat 3%" })])).toBeNull();
  });

  it("accepts the standard 5-tier marginal set", () => {
    const tiers: TierInput[] = [
      tier({ label: "Up to $750k", minYtdSales: 0, maxYtdSalesExclusive: 750_000, rate: 0.03 }),
      tier({
        label: "$750k – $1M",
        minYtdSales: 750_000,
        maxYtdSalesExclusive: 1_000_000,
        rate: 0.04,
        sortOrder: 1,
      }),
      tier({
        label: "$1M – $1.5M",
        minYtdSales: 1_000_000,
        maxYtdSalesExclusive: 1_500_000,
        rate: 0.05,
        sortOrder: 2,
      }),
      tier({
        label: "$1.5M – $2M",
        minYtdSales: 1_500_000,
        maxYtdSalesExclusive: 2_000_000,
        rate: 0.06,
        sortOrder: 3,
      }),
      tier({
        label: "Over $2M",
        minYtdSales: 2_000_000,
        maxYtdSalesExclusive: null,
        rate: 0.07,
        sortOrder: 4,
      }),
    ];
    expect(validatePlanTiers(tiers)).toBeNull();
  });

  describe("label", () => {
    it("rejects an empty label", () => {
      expect(validatePlanTiers([tier({ label: "" })])).toBe("Tier 1: missing label");
    });

    it("rejects a non-string label", () => {
      expect(validatePlanTiers([tier({ label: 7 as unknown as string })])).toBe(
        "Tier 1: missing label",
      );
    });

    it("names the offending position when a later tier is missing its label", () => {
      const tiers = [
        tier({ label: "First", maxYtdSalesExclusive: 100 }),
        tier({ label: "", minYtdSales: 100, sortOrder: 1 }),
      ];
      expect(validatePlanTiers(tiers)).toBe("Tier 2: missing label");
    });
  });

  describe("rate", () => {
    it("rejects a negative rate", () => {
      expect(validatePlanTiers([tier({ label: "Bad", rate: -0.01 })])).toBe(
        "Tier 1 (Bad): rate must be between 0 and 1",
      );
    });

    it("rejects a rate above 1", () => {
      expect(validatePlanTiers([tier({ label: "Bad", rate: 1.01 })])).toBe(
        "Tier 1 (Bad): rate must be between 0 and 1",
      );
    });

    it("rejects a non-numeric rate", () => {
      expect(validatePlanTiers([tier({ label: "Bad", rate: "0.05" as unknown as number })])).toBe(
        "Tier 1 (Bad): rate must be between 0 and 1",
      );
    });

    it("accepts the boundary rates 0 and 1", () => {
      expect(validatePlanTiers([tier({ label: "Zero", rate: 0 })])).toBeNull();
      expect(validatePlanTiers([tier({ label: "All", rate: 1 })])).toBeNull();
    });
  });

  describe("minYtdSales", () => {
    it("rejects a negative minYtdSales", () => {
      expect(validatePlanTiers([tier({ label: "Bad", minYtdSales: -1 })])).toBe(
        "Tier 1 (Bad): minYtdSales must be >= 0",
      );
    });

    it("rejects a non-numeric minYtdSales", () => {
      expect(
        validatePlanTiers([tier({ label: "Bad", minYtdSales: "0" as unknown as number })]),
      ).toBe("Tier 1 (Bad): minYtdSales must be >= 0");
    });
  });

  describe("unbounded tiers", () => {
    it("rejects an unbounded tier that is not last", () => {
      const tiers = [
        tier({ label: "Open", maxYtdSalesExclusive: null }),
        tier({ label: "Top", minYtdSales: 100, sortOrder: 1 }),
      ];
      expect(validatePlanTiers(tiers)).toBe("Tier 1 (Open): only the last tier may be unbounded");
    });

    it("allows the last tier to be bounded (a capped plan)", () => {
      const tiers = [tier({ label: "Only", minYtdSales: 0, maxYtdSalesExclusive: 500_000 })];
      expect(validatePlanTiers(tiers)).toBeNull();
    });
  });

  describe("max > min", () => {
    it("rejects max equal to min on a non-last tier", () => {
      const tiers = [
        tier({ label: "Bad", minYtdSales: 100, maxYtdSalesExclusive: 100 }),
        tier({ label: "Top", minYtdSales: 100, sortOrder: 1 }),
      ];
      expect(validatePlanTiers(tiers)).toBe(
        "Tier 1 (Bad): maxYtdSalesExclusive must be > minYtdSales",
      );
    });

    it("rejects max below min on the LAST tier when bounded", () => {
      const tiers = [tier({ label: "Bad", minYtdSales: 200, maxYtdSalesExclusive: 100 })];
      expect(validatePlanTiers(tiers)).toBe(
        "Tier 1 (Bad): maxYtdSalesExclusive must be > minYtdSales",
      );
    });
  });

  describe("contiguity", () => {
    it("rejects a gap between brackets", () => {
      const tiers = [
        tier({ label: "Low", minYtdSales: 0, maxYtdSalesExclusive: 100_000 }),
        tier({ label: "High", minYtdSales: 150_000, sortOrder: 1 }),
      ];
      expect(validatePlanTiers(tiers)).toBe("Tiers 1 → 2: brackets must be contiguous");
    });

    it("rejects an overlap between brackets", () => {
      const tiers = [
        tier({ label: "Low", minYtdSales: 0, maxYtdSalesExclusive: 100_000 }),
        tier({ label: "High", minYtdSales: 50_000, sortOrder: 1 }),
      ];
      expect(validatePlanTiers(tiers)).toBe("Tiers 1 → 2: brackets must be contiguous");
    });

    it("names the failing pair in a longer set", () => {
      const tiers = [
        tier({ label: "A", minYtdSales: 0, maxYtdSalesExclusive: 100 }),
        tier({ label: "B", minYtdSales: 100, maxYtdSalesExclusive: 200, sortOrder: 1 }),
        tier({ label: "C", minYtdSales: 250, sortOrder: 2 }),
      ];
      expect(validatePlanTiers(tiers)).toBe("Tiers 2 → 3: brackets must be contiguous");
    });
  });
});
