// /app/__tests__/grossMargin.test.ts
//
// Pure unit tests for summarizeGrossMargin — the row-shaping half of the gross
// margin report (rounding, margin %, sort, totals). No database: the SQL half
// (getGrossMargin) is validated against real data; this pins the math.

import { summarizeGrossMargin, type GrossMarginRawRow } from "@/lib/reports/grossMargin";

const meta = { pivot: "department" as const, startDate: "2026-01-01", endDate: "2026-06-05" };

describe("summarizeGrossMargin", () => {
  it("derives margin and margin % and rounds money to cents", () => {
    const raw: GrossMarginRawRow[] = [
      { key: "Furniture", revenue: 1000.005, cost: 600.004, units: 3, line_count: 2 },
    ];
    const { rows } = summarizeGrossMargin(raw, meta);
    expect(rows[0].revenue).toBe(1000.01);
    expect(rows[0].cost).toBe(600);
    expect(rows[0].margin).toBe(400.01);
    expect(rows[0].marginPct).toBe(40); // 400.01 / 1000.01 = 40.0006% -> 40.0
  });

  it("returns null margin % when revenue is 0 (no divide-by-zero)", () => {
    const raw: GrossMarginRawRow[] = [
      { key: "Freebies", revenue: 0, cost: 0, units: 1, line_count: 1 },
    ];
    expect(summarizeGrossMargin(raw, meta).rows[0].marginPct).toBeNull();
  });

  it("sorts rows by margin dollars, highest first", () => {
    const raw: GrossMarginRawRow[] = [
      { key: "Low", revenue: 100, cost: 90, units: 1, line_count: 1 }, // margin 10
      { key: "High", revenue: 500, cost: 100, units: 1, line_count: 1 }, // margin 400
      { key: "Mid", revenue: 300, cost: 200, units: 1, line_count: 1 }, // margin 100
    ];
    expect(summarizeGrossMargin(raw, meta).rows.map((r) => r.key)).toEqual(["High", "Mid", "Low"]);
  });

  it("totals revenue, cost, margin, units, and line count across rows", () => {
    const raw: GrossMarginRawRow[] = [
      { key: "A", revenue: 1000, cost: 400, units: 5, line_count: 3 },
      { key: "B", revenue: 500, cost: 300, units: 2, line_count: 4 },
    ];
    const { totals } = summarizeGrossMargin(raw, meta);
    expect(totals.revenue).toBe(1500);
    expect(totals.cost).toBe(700);
    expect(totals.margin).toBe(800);
    expect(totals.marginPct).toBeCloseTo(53.33, 2);
    expect(totals.units).toBe(7);
    expect(totals.lineCount).toBe(7);
  });

  it("labels a null group key as Uncategorized and rounds fractional units", () => {
    const raw: GrossMarginRawRow[] = [
      { key: null, revenue: 50, cost: 20, units: 2.6, line_count: 1 },
    ];
    const row = summarizeGrossMargin(raw, meta).rows[0];
    expect(row.key).toBe("Uncategorized");
    expect(row.units).toBe(3);
  });

  it("carries the pivot and date range through unchanged", () => {
    const result = summarizeGrossMargin([], {
      pivot: "vendor",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(result.pivot).toBe("vendor");
    expect(result.startDate).toBe("2025-01-01");
    expect(result.endDate).toBe("2025-12-31");
    expect(result.rows).toEqual([]);
    expect(result.totals.marginPct).toBeNull();
  });

  it("handles negative margin (cost exceeds revenue) without breaking the sort", () => {
    const raw: GrossMarginRawRow[] = [
      { key: "Loss", revenue: 100, cost: 150, units: 1, line_count: 1 }, // margin -50
      { key: "Gain", revenue: 200, cost: 50, units: 1, line_count: 1 }, // margin 150
    ];
    const { rows } = summarizeGrossMargin(raw, meta);
    expect(rows.map((r) => r.key)).toEqual(["Gain", "Loss"]);
    expect(rows[1].margin).toBe(-50);
    expect(rows[1].marginPct).toBe(-50); // -50 / 100
  });
});
