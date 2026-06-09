// /app/__tests__/returnsAnalysis.test.ts
//
// Pure unit tests for summarizeReturns — the row-shaping half of the returns
// report (magnitude of negative credits, return rate, filter, sort, totals, top
// products). No database: the SQL half (getReturnsAnalysis) is validated against
// real data; this pins the math.

import {
  summarizeReturns,
  type ReturnsRawGroupRow,
  type ReturnsRawProductRow,
} from "@/lib/reports/returnsAnalysis";

const meta = { pivot: "department" as const, startDate: "2026-01-01", endDate: "2026-06-05" };

describe("summarizeReturns", () => {
  it("takes the magnitude of negative return credits and derives return rate", () => {
    const groups: ReturnsRawGroupRow[] = [
      { key: "Furniture", gross: 10000, returns_net: -1500, returned_units: -3 },
    ];
    const { rows } = summarizeReturns(groups, [], meta);
    expect(rows[0].returns).toBe(1500); // magnitude of -1500
    expect(rows[0].returnedUnits).toBe(3); // magnitude of -3
    expect(rows[0].returnRate).toBe(15); // 1500 / 10000
  });

  it("returns null rate when gross is 0", () => {
    const groups: ReturnsRawGroupRow[] = [
      { key: "X", gross: 0, returns_net: -50, returned_units: -1 },
    ];
    expect(summarizeReturns(groups, [], meta).rows[0].returnRate).toBeNull();
  });

  it("drops groups with neither gross nor returns, and sorts by returns desc", () => {
    const groups: ReturnsRawGroupRow[] = [
      { key: "Empty", gross: 0, returns_net: 0, returned_units: 0 },
      { key: "Small", gross: 500, returns_net: -50, returned_units: -1 },
      { key: "Big", gross: 9000, returns_net: -900, returned_units: -4 },
    ];
    const { rows } = summarizeReturns(groups, [], meta);
    expect(rows.map((r) => r.key)).toEqual(["Big", "Small"]); // Empty dropped, sorted by returns
  });

  it("totals gross, returns, and units, and computes overall rate", () => {
    const groups: ReturnsRawGroupRow[] = [
      { key: "A", gross: 8000, returns_net: -800, returned_units: -2 },
      { key: "B", gross: 2000, returns_net: -200, returned_units: -1 },
    ];
    const { totals } = summarizeReturns(groups, [], meta);
    expect(totals.grossSales).toBe(10000);
    expect(totals.returns).toBe(1000);
    expect(totals.returnedUnits).toBe(3);
    expect(totals.returnRate).toBe(10); // 1000 / 10000
  });

  it("maps top returned products with magnitude + unnamed fallback", () => {
    const products: ReturnsRawProductRow[] = [
      { product_number: "WH-1", name: "Sofa", returns_net: -1200, returned_units: -2 },
      { product_number: null, name: null, returns_net: -300, returned_units: -1 },
    ];
    const { topReturnedProducts } = summarizeReturns([], products, meta);
    expect(topReturnedProducts[0]).toMatchObject({
      productNumber: "WH-1",
      name: "Sofa",
      returns: 1200,
      returnedUnits: 2,
    });
    expect(topReturnedProducts[1].name).toBe("(unnamed)");
  });

  it("carries pivot + date range and handles an empty period", () => {
    const result = summarizeReturns([], [], {
      pivot: "vendor",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(result.pivot).toBe("vendor");
    expect(result.startDate).toBe("2025-01-01");
    expect(result.rows).toEqual([]);
    expect(result.totals.returnRate).toBeNull();
  });
});
