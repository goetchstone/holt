// /app/__tests__/designerDashboardTotalKey.test.ts
//
// Pins the separation between a report GROUP bucket and the grand-total bucket.
//
// Bug class introduced when department report groups became operator-named
// (migration 20260821120000_department_report_roles): the total lived under the
// literal key "All", so a deployment that named a group "All" put its lines in
// the same bucket twice -- once as their category, once as the total. Every KPI
// reading the total (annualized sales, average order value, gross margin) would
// have been inflated by that group's revenue, silently. The total now lives
// under TOTAL_KEY, which no department group can be.

import {
  accumulateLineItem,
  TOTAL_KEY,
  type CategoryMetrics,
  type DashboardLineItem,
} from "@/lib/reports/designerDashboard";
import type { ReportTaxonomy } from "@/lib/reports/reportTaxonomy";

/** The hostile case: an operator names a report group "All". */
const COLLIDING: ReportTaxonomy = {
  groupByDepartment: new Map([["clearance", "All"]]),
  groups: ["All"],
  excludedDepartments: [],
  crossSellTargets: [],
  crossSellAnchor: null,
};

function seeded(): Record<string, CategoryMetrics> {
  return {
    All: { revenue: 0, cost: 0, count: 0 },
    [TOTAL_KEY]: { revenue: 0, cost: 0, count: 0 },
  };
}

function line(): DashboardLineItem {
  return {
    netPrice: 100,
    cost: 40,
    orderedQuantity: 1,
    product: { department: { name: "Clearance" } },
  };
}

describe("the grand-total bucket cannot collide with a report group", () => {
  it("does not use a key a department group could occupy", () => {
    expect(COLLIDING.groups).toContain("All");
    expect(COLLIDING.groups).not.toContain(TOTAL_KEY);
  });

  it("counts a line in a group named All exactly once in the total", () => {
    const result = seeded();
    accumulateLineItem(result, line(), 1, COLLIDING);

    // Pre-fix this was 200/80/2 -- the category write and the total write
    // landed on the same bucket.
    expect(result[TOTAL_KEY].revenue).toBe(100);
    expect(result[TOTAL_KEY].cost).toBe(40);
    expect(result[TOTAL_KEY].count).toBe(1);
  });

  it("still credits the group itself exactly once", () => {
    const result = seeded();
    accumulateLineItem(result, line(), 1, COLLIDING);

    expect(result.All.revenue).toBe(100);
    expect(result.All.count).toBe(1);
  });

  it("keeps the two buckets independent across several lines", () => {
    const result = seeded();
    for (let i = 0; i < 3; i++) accumulateLineItem(result, line(), 1, COLLIDING);

    expect(result.All.revenue).toBe(300);
    expect(result[TOTAL_KEY].revenue).toBe(300);
    // The failure mode was the total running ahead of the group it duplicated.
    expect(result[TOTAL_KEY].revenue).toBe(result.All.revenue);
  });
});
