// /app/__tests__/serviceKpi.test.ts
//
// Pure-helper tests for the service-KPI math used by the manager
// report at /reports/service. Verifies avg / median / p90 /
// goal-met-percent + age-bucket binning + per-month resolution trend
// + "waiting externally" sum.

import { computeServiceKpis } from "../src/lib/serviceKpi";

const NOW = new Date("2026-05-27T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("computeServiceKpis — resolution-time math", () => {
  it("computes avg / median / p90 correctly on a known set", () => {
    // Resolution times in days: [1, 3, 5, 14, 60]
    const closedSamples = [1, 3, 5, 14, 60].map((d) => ({
      createdAt: daysAgo(90),
      resolvedAt: new Date(daysAgo(90).getTime() + d * DAY),
    }));
    const k = computeServiceKpis({
      openCases: [],
      closedSamples,
      trendSamples: closedSamples,
      goalDays: 14,
      externalWaitStatusNames: [],
      now: NOW,
    });
    expect(k.avgResolutionDays).toBe(16.6);
    expect(k.medianResolutionDays).toBe(5);
    // p90 on [1,3,5,14,60] = interpolated rank 3.6 → 14 + 0.6*(60-14) = 41.6
    expect(k.p90ResolutionDays).toBe(41.6);
    expect(k.closedInWindowCount).toBe(5);
  });

  it("returns null resolution stats when no closed cases", () => {
    const k = computeServiceKpis({
      openCases: [],
      closedSamples: [],
      trendSamples: [],
      goalDays: 14,
      externalWaitStatusNames: [],
      now: NOW,
    });
    expect(k.avgResolutionDays).toBeNull();
    expect(k.medianResolutionDays).toBeNull();
    expect(k.p90ResolutionDays).toBeNull();
    expect(k.goalMetPercent).toBe(0);
  });

  it("counts goal-met correctly (boundary inclusive)", () => {
    // Goal=14. Resolved in 1, 14 (exactly), 15, 30 → 2 of 4 met = 50%
    const closedSamples = [1, 14, 15, 30].map((d) => ({
      createdAt: daysAgo(60),
      resolvedAt: new Date(daysAgo(60).getTime() + d * DAY),
    }));
    const k = computeServiceKpis({
      openCases: [],
      closedSamples,
      trendSamples: closedSamples,
      goalDays: 14,
      externalWaitStatusNames: [],
      now: NOW,
    });
    expect(k.goalMetCount).toBe(2);
    expect(k.goalMetPercent).toBe(50);
  });
});

describe("computeServiceKpis — open-queue health", () => {
  it("counts open, computes oldest age, and bins ages into the right buckets", () => {
    const openCases = [
      { id: 1, createdAt: daysAgo(2), statusName: "Open" }, // <7d
      { id: 2, createdAt: daysAgo(5), statusName: "Open" }, // <7d
      { id: 3, createdAt: daysAgo(15), statusName: "Waiting on Vendor" }, // 7–30d
      { id: 4, createdAt: daysAgo(45), statusName: "Waiting on Customer" }, // 30–60d
      { id: 5, createdAt: daysAgo(120), statusName: "Open" }, // 60+
    ];
    const k = computeServiceKpis({
      openCases,
      closedSamples: [],
      trendSamples: [],
      goalDays: 14,
      externalWaitStatusNames: ["Waiting on Vendor", "Waiting on Customer"],
      now: NOW,
    });
    expect(k.openCount).toBe(5);
    expect(k.oldestOpenAgeDays).toBe(120);
    expect(k.waitingExternallyCount).toBe(2);

    const bucketCounts = Object.fromEntries(k.ageBuckets.map((b) => [b.label, b.count]));
    expect(bucketCounts["< 7 days"]).toBe(2);
    expect(bucketCounts["7–30 days"]).toBe(1);
    expect(bucketCounts["30–60 days"]).toBe(1);
    expect(bucketCounts["60+ days"]).toBe(1);
  });

  it("groups open cases by status, sorted descending", () => {
    const openCases = [
      { id: 1, createdAt: daysAgo(1), statusName: "Open" },
      { id: 2, createdAt: daysAgo(1), statusName: "Open" },
      { id: 3, createdAt: daysAgo(1), statusName: "Open" },
      { id: 4, createdAt: daysAgo(1), statusName: "Waiting on Vendor" },
      { id: 5, createdAt: daysAgo(1), statusName: "Service Call" },
    ];
    const k = computeServiceKpis({
      openCases,
      closedSamples: [],
      trendSamples: [],
      goalDays: 14,
      externalWaitStatusNames: [],
      now: NOW,
    });
    expect(k.openByStatus).toEqual([
      { statusName: "Open", count: 3 },
      // The order of the two 1-count entries is implementation-specific
      // but stable enough to assert as a set.
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
    ]);
  });

  it("waiting-externally count is case-insensitive (status name might be mis-cased)", () => {
    const openCases = [
      { id: 1, createdAt: daysAgo(1), statusName: "waiting on vendor" }, // lowercase
      { id: 2, createdAt: daysAgo(1), statusName: "WAITING ON CUSTOMER" }, // uppercase
      { id: 3, createdAt: daysAgo(1), statusName: "Open" },
    ];
    const k = computeServiceKpis({
      openCases,
      closedSamples: [],
      trendSamples: [],
      goalDays: 14,
      externalWaitStatusNames: ["Waiting on Vendor", "Waiting on Customer"],
      now: NOW,
    });
    expect(k.waitingExternallyCount).toBe(2);
  });
});

describe("computeServiceKpis — resolution trend per month", () => {
  it("buckets closed cases by their resolvedAt month + averages within", () => {
    // 3 cases resolved in 2025-12 with days [5, 5, 10] → avg 6.67
    // 2 cases resolved in 2026-01 with days [2, 8] → avg 5.0
    const c1 = {
      createdAt: new Date("2025-12-01T00:00:00Z"),
      resolvedAt: new Date("2025-12-06T00:00:00Z"),
    }; // 5d
    const c2 = {
      createdAt: new Date("2025-12-10T00:00:00Z"),
      resolvedAt: new Date("2025-12-15T00:00:00Z"),
    }; // 5d
    const c3 = {
      createdAt: new Date("2025-12-15T00:00:00Z"),
      resolvedAt: new Date("2025-12-25T00:00:00Z"),
    }; // 10d
    const c4 = {
      createdAt: new Date("2026-01-01T00:00:00Z"),
      resolvedAt: new Date("2026-01-03T00:00:00Z"),
    }; // 2d
    const c5 = {
      createdAt: new Date("2026-01-10T00:00:00Z"),
      resolvedAt: new Date("2026-01-18T00:00:00Z"),
    }; // 8d
    const k = computeServiceKpis({
      openCases: [],
      closedSamples: [],
      trendSamples: [c1, c2, c3, c4, c5],
      goalDays: 14,
      externalWaitStatusNames: [],
      now: NOW,
    });
    expect(k.resolutionTrend).toEqual([
      { month: "2025-12", closedCount: 3, avgDays: 6.7 },
      { month: "2026-01", closedCount: 2, avgDays: 5 },
    ]);
  });

  it("returns [] when no trend samples", () => {
    const k = computeServiceKpis({
      openCases: [],
      closedSamples: [],
      trendSamples: [],
      goalDays: 14,
      externalWaitStatusNames: [],
      now: NOW,
    });
    expect(k.resolutionTrend).toEqual([]);
  });
});
