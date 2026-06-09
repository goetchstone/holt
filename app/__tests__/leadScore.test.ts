// /app/__tests__/leadScore.test.ts

import { calculateLeadScore, leadTierLabel } from "../src/lib/leadScore";

describe("calculateLeadScore", () => {
  it("scores zero for empty input", () => {
    const result = calculateLeadScore({});
    expect(result.score).toBe(0);
    expect(result.tier).toBe("NEW");
  });

  it("handles null values gracefully", () => {
    const result = calculateLeadScore({
      lifetimeSpend: null,
      lifetimeOrderCount: null,
      customerLevel: null,
      peakCustomerLevel: null,
      departmentCount: null,
      lastOrderDate: null,
      wealthTier: null,
    });
    expect(result.score).toBe(0);
    expect(result.tier).toBe("NEW");
  });

  it("scores a dormant VIP as hot without wealth data", () => {
    // $25K spend, 4 groups, peak VIP, recent order, no wealth
    const result = calculateLeadScore({
      lifetimeSpend: 25000,
      departmentCount: 4,
      peakCustomerLevel: 4,
      lastOrderDate: new Date(),
    });
    expect(result.factors.spend).toBe(40);
    expect(result.factors.breadth).toBe(15);
    expect(result.factors.level).toBe(20);
    expect(result.factors.wealth).toBe(0);
    expect(result.factors.recency).toBe(5);
    expect(result.score).toBe(80);
    expect(result.tier).toBe("HOT");
  });

  it("bumps a modest spender with wealth data into warm", () => {
    const result = calculateLeadScore({
      lifetimeSpend: 2000,
      departmentCount: 2,
      customerLevel: 2,
      peakCustomerLevel: 2,
      lastOrderDate: new Date(),
      wealthTier: "VERY_HIGH",
    });
    expect(result.factors.spend).toBeGreaterThanOrEqual(15);
    expect(result.factors.wealth).toBe(15);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.tier).not.toBe("COOL");
  });

  it("uses peak level when current is null (dormant VIP)", () => {
    const result = calculateLeadScore({
      customerLevel: null,
      peakCustomerLevel: 4,
    });
    expect(result.factors.level).toBe(20);
  });

  it("recency scales from 5 (recent) to 0 (old)", () => {
    const recent = calculateLeadScore({
      lastOrderDate: new Date(Date.now() - 30 * 86400000),
    });
    expect(recent.factors.recency).toBe(5);

    const mid = calculateLeadScore({
      lastOrderDate: new Date(Date.now() - 120 * 86400000),
    });
    expect(mid.factors.recency).toBe(3);

    const old = calculateLeadScore({
      lastOrderDate: new Date(Date.now() - 200 * 86400000),
    });
    expect(old.factors.recency).toBe(1);

    const ancient = calculateLeadScore({
      lastOrderDate: new Date(Date.now() - 400 * 86400000),
    });
    expect(ancient.factors.recency).toBe(0);
  });

  it("tier thresholds are correct", () => {
    // 70+ = HOT
    expect(
      calculateLeadScore({
        lifetimeSpend: 20000,
        departmentCount: 4,
        peakCustomerLevel: 4,
        lastOrderDate: new Date(),
      }).tier,
    ).toBe("HOT");
    // 50-69 = WARM
    expect(
      calculateLeadScore({ lifetimeSpend: 5000, departmentCount: 3, peakCustomerLevel: 3 }).tier,
    ).toBe("WARM");
    // 30-49 = COOL
    expect(
      calculateLeadScore({ lifetimeSpend: 2000, departmentCount: 2, peakCustomerLevel: 2 }).tier,
    ).toBe("COOL");
    // <30 = NEW
    expect(calculateLeadScore({ lifetimeSpend: 500 }).tier).toBe("NEW");
  });

  it("ULTRA_HIGH wealth contributes max points", () => {
    const result = calculateLeadScore({ wealthTier: "ULTRA_HIGH" });
    expect(result.factors.wealth).toBe(20);
  });

  it("unknown wealth tier scores zero", () => {
    const result = calculateLeadScore({ wealthTier: "BOGUS" });
    expect(result.factors.wealth).toBe(0);
  });
});

describe("calculateLeadScore — life events", () => {
  it("adds 5 points for a recent mover", () => {
    const baseline = calculateLeadScore({ lifetimeSpend: 2000 });
    const moved = calculateLeadScore({ lifetimeSpend: 2000, recentMover: true });
    expect(moved.factors.lifeEvents).toBe(5);
    expect(moved.score).toBe(baseline.score + 5);
    expect(moved.lifeEventReasons).toEqual(["Recent mover"]);
  });

  it("stacks multiple life events up to the 10-point cap", () => {
    const result = calculateLeadScore({
      recentMover: true, // 5
      recentMortgage: true, // 3
      recentlyDivorced: true, // 2
      moneyInMotion: true, // 2
      liquidityTrigger: true, // 2
      // raw = 14 → capped at 10
    });
    expect(result.factors.lifeEvents).toBe(10);
    expect(result.lifeEventReasons).toHaveLength(5);
  });

  it("can bump a borderline WARM customer into HOT", () => {
    // 65-point baseline customer — would be WARM
    const base = {
      lifetimeSpend: 5000, // 25
      departmentCount: 3, // 10
      peakCustomerLevel: 3, // 15
      wealthTier: "HIGH", // 10
      lastOrderDate: new Date(), // 5
    };
    const baseline = calculateLeadScore(base);
    expect(baseline.tier).toBe("WARM");

    const withMove = calculateLeadScore({ ...base, recentMover: true });
    expect(withMove.tier).toBe("HOT");
  });

  it("caps final score at 100 even with stacked high signals", () => {
    const result = calculateLeadScore({
      lifetimeSpend: 100000, // 40
      departmentCount: 5, // 15
      peakCustomerLevel: 4, // 20
      wealthTier: "ULTRA_HIGH", // 20
      lastOrderDate: new Date(), // 5
      recentMover: true,
      recentMortgage: true,
      // raw = 100 + 8 = 108 → capped at 100
    });
    expect(result.score).toBe(100);
    expect(result.tier).toBe("HOT");
  });

  it("no life-event reasons when no signals are set", () => {
    const result = calculateLeadScore({ lifetimeSpend: 1000 });
    expect(result.factors.lifeEvents).toBe(0);
    expect(result.lifeEventReasons).toEqual([]);
  });
});

describe("leadTierLabel", () => {
  it("returns human-readable labels", () => {
    expect(leadTierLabel("HOT")).toBe("Hot Lead");
    expect(leadTierLabel("WARM")).toBe("Warm");
    expect(leadTierLabel("COOL")).toBe("Cool");
    expect(leadTierLabel("NEW")).toBe("New");
  });
});
