// /app/__tests__/weeklySummaryRows.test.ts
//
// Pure tests for the Weekly Summary row builder: YoY math, the
// this-week ∪ last-year entity union, company-only traffic attach,
// goal proration, and sort order.

import { buildRows, type BuildRowsArgs } from "../src/lib/weeklySummaryRows";

function base(over: Partial<BuildRowsArgs>): BuildRowsArgs {
  return {
    entityNames: new Set(),
    thisWeek: new Map(),
    lastYear: new Map(),
    annualGoals: new Map(),
    monthPercent: 0,
    daysInMonth: 30,
    reportDays: 7,
    wow: true,
    typeParam: "company",
    trafficThis: {},
    trafficLast: {},
    transThis: {},
    transLast: {},
    ...over,
  };
}

describe("buildRows", () => {
  it("legacy (wow=false) returns actual/goal/variance only, no YoY", () => {
    const rows = buildRows(
      base({
        wow: false,
        entityNames: new Set(["Main Store"]),
        thisWeek: new Map([["Main Store", 1000]]),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actual).toBe(1000);
    expect(rows[0].lastYear).toBeUndefined();
    expect(rows[0].yoyPercent).toBeUndefined();
    expect(rows[0].visitors).toBeUndefined();
  });

  it("computes YoY $ and % against last year", () => {
    const rows = buildRows(
      base({
        entityNames: new Set(["Cheshire"]),
        thisWeek: new Map([["Cheshire", 1200]]),
        lastYear: new Map([["Cheshire", 1000]]),
      }),
    );
    expect(rows[0].lastYear).toBe(1000);
    expect(rows[0].yoyVariance).toBe(200);
    expect(rows[0].yoyPercent).toBeCloseTo(20, 5);
  });

  it("yoyPercent is null when last year was zero (no divide-by-zero)", () => {
    const rows = buildRows(
      base({
        entityNames: new Set(["NewStore"]),
        thisWeek: new Map([["NewStore", 500]]),
        lastYear: new Map(),
      }),
    );
    expect(rows[0].lastYear).toBe(0);
    expect(rows[0].yoyVariance).toBe(500);
    expect(rows[0].yoyPercent).toBeNull();
  });

  it("unions entities present only last year (shows as a full drop)", () => {
    const rows = buildRows(
      base({
        entityNames: new Set(["A", "B"]),
        thisWeek: new Map([["A", 100]]),
        lastYear: new Map([["B", 300]]),
      }),
    );
    const b = rows.find((r) => r.entityName === "B");
    expect(b?.actual).toBe(0);
    expect(b?.lastYear).toBe(300);
    expect(b?.yoyVariance).toBe(-300);
  });

  it("attaches visitors only for company grouping", () => {
    const company = buildRows(
      base({
        typeParam: "company",
        entityNames: new Set(["Downtown"]),
        thisWeek: new Map([["Downtown", 800]]),
        trafficThis: { Downtown: 120 },
        trafficLast: { Downtown: 100 },
      }),
    );
    expect(company[0].visitors).toBe(120);
    expect(company[0].visitorsLastYear).toBe(100);

    const dept = buildRows(
      base({
        typeParam: "department",
        entityNames: new Set(["Rugs"]),
        thisWeek: new Map([["Rugs", 800]]),
        trafficThis: { Rugs: 120 },
      }),
    );
    expect(dept[0].visitors).toBeUndefined();
  });

  it("computes conversion % = transactions ÷ visitors (company only)", () => {
    const rows = buildRows(
      base({
        typeParam: "company",
        entityNames: new Set(["Cheshire"]),
        thisWeek: new Map([["Cheshire", 5000]]),
        trafficThis: { Cheshire: 200 },
        trafficLast: { Cheshire: 160 },
        transThis: { Cheshire: 50 }, // 50/200 = 25%
        transLast: { Cheshire: 32 }, // 32/160 = 20%
      }),
    );
    expect(rows[0].conversionPct).toBeCloseTo(25, 5);
    expect(rows[0].conversionPctLastYear).toBeCloseTo(20, 5);
  });

  it("conversion is null when there are no visitors (no divide-by-zero)", () => {
    const rows = buildRows(
      base({
        typeParam: "company",
        entityNames: new Set(["Quiet Store"]),
        thisWeek: new Map([["Quiet Store", 0]]),
        trafficThis: {},
        transThis: { "Quiet Store": 3 },
      }),
    );
    expect(rows[0].conversionPct).toBeNull();
  });

  it("does not attach conversion for non-company grouping", () => {
    const rows = buildRows(
      base({
        typeParam: "department",
        entityNames: new Set(["Rugs"]),
        thisWeek: new Map([["Rugs", 800]]),
        transThis: { Rugs: 10 },
      }),
    );
    expect(rows[0].conversionPct).toBeUndefined();
  });

  it("prorates the goal: annualGoal × monthPercent / daysInMonth × reportDays", () => {
    const rows = buildRows(
      base({
        entityNames: new Set(["Main Store"]),
        thisWeek: new Map([["Main Store", 0]]),
        annualGoals: new Map([["Main Store", 300000]]),
        monthPercent: 0.1, // 10% of the year lands this month
        daysInMonth: 30,
        reportDays: 7,
      }),
    );
    // 300000 * 0.1 / 30 * 7 = 7000
    expect(rows[0].goal).toBeCloseTo(7000, 5);
    expect(rows[0].variance).toBeCloseTo(-7000, 5);
  });

  it("sorts rows by this-week actual descending", () => {
    const rows = buildRows(
      base({
        entityNames: new Set(["Small", "Big", "Mid"]),
        thisWeek: new Map([
          ["Small", 100],
          ["Big", 900],
          ["Mid", 500],
        ]),
      }),
    );
    expect(rows.map((r) => r.entityName)).toEqual(["Big", "Mid", "Small"]);
  });
});
