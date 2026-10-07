// /app/__tests__/topSellers.test.ts
//
// Pure unit tests for the top-sellers report helpers: resolveTopSellersParams
// (untrusted-input normalization — metric guard, limit clamp, dept cleanup) and
// mapTopSellerRow (revenue/cost/margin shaping). No database: the SQL half
// (getTopSellers) is validated against real data; this pins the math + guards.

import {
  resolveTopSellersParams,
  mapTopSellerRow,
  topSellersForCaller,
  topSellersMetricFor,
  type TopSellerRawRow,
  type TopSellersResult,
} from "@/lib/reports/topSellers";

const base = { startDate: "2026-01-01", endDate: "2026-06-05" };

describe("resolveTopSellersParams", () => {
  it("defaults an invalid/missing metric to revenue", () => {
    expect(resolveTopSellersParams({ ...base }).metric).toBe("revenue");
    expect(resolveTopSellersParams({ ...base, metric: "bogus" as never }).metric).toBe("revenue");
  });

  it("passes through valid metrics", () => {
    expect(resolveTopSellersParams({ ...base, metric: "margin" }).metric).toBe("margin");
    expect(resolveTopSellersParams({ ...base, metric: "units" }).metric).toBe("units");
  });

  it("clamps limit to 1-100 and floors fractions; defaults to 25", () => {
    expect(resolveTopSellersParams({ ...base }).limit).toBe(25);
    expect(resolveTopSellersParams({ ...base, limit: 0 }).limit).toBe(1);
    expect(resolveTopSellersParams({ ...base, limit: 5000 }).limit).toBe(100);
    expect(resolveTopSellersParams({ ...base, limit: 12.9 }).limit).toBe(12);
  });

  it("drops blank/whitespace department names", () => {
    expect(
      resolveTopSellersParams({ ...base, departments: ["Furniture", "  ", "", "Rugs"] })
        .departments,
    ).toEqual(["Furniture", "Rugs"]);
  });
});

describe("mapTopSellerRow", () => {
  function raw(over: Partial<TopSellerRawRow>): TopSellerRawRow {
    return {
      product_number: "WH-1",
      name: "Sofa",
      department: "Furniture",
      vendor: "Wesley Hall",
      units: 0,
      revenue: 0,
      cost: 0,
      ...over,
    };
  }

  it("derives margin and margin % from line totals", () => {
    const row = mapTopSellerRow(raw({ units: 4, revenue: 1000, cost: 600 }));
    expect(row.margin).toBe(400);
    expect(row.marginPct).toBe(40);
    expect(row.units).toBe(4);
  });

  it("returns null margin % when revenue is 0", () => {
    expect(mapTopSellerRow(raw({ revenue: 0, cost: 0 })).marginPct).toBeNull();
  });

  it("applies fallbacks for null name/department/vendor", () => {
    const row = mapTopSellerRow(raw({ name: null, department: null, vendor: null }));
    expect(row.name).toBe("(unnamed)");
    expect(row.department).toBe("Uncategorized");
    expect(row.vendor).toBe("No Vendor");
  });

  it("handles negative margin (cost exceeds revenue)", () => {
    const row = mapTopSellerRow(raw({ revenue: 100, cost: 150 }));
    expect(row.margin).toBe(-50);
    expect(row.marginPct).toBe(-50);
  });
});

describe("View cost", () => {
  it("a margin ranking is answered by revenue without View cost; nothing else changes", () => {
    expect(topSellersMetricFor("margin", false)).toBe("revenue");
    expect(topSellersMetricFor("margin", true)).toBe("margin");
    expect(topSellersMetricFor("units", false)).toBe("units");
    expect(topSellersMetricFor("units", true)).toBe("units");
    expect(topSellersMetricFor("revenue", false)).toBe("revenue");
    expect(topSellersMetricFor(undefined, false)).toBeUndefined();
  });

  const row = mapTopSellerRow({
    product_number: "P-1",
    name: "Lamp",
    department: "Lighting",
    vendor: "Heron",
    units: 2,
    revenue: 600,
    cost: 100,
  });
  const result: TopSellersResult = {
    metric: "revenue",
    startDate: "2026-01-01",
    endDate: "2026-06-05",
    limit: 25,
    departments: [],
    top: [row],
    bottom: [row],
  };

  it("a holder gets the rankings unchanged", () => {
    expect(topSellersForCaller(result, true)).toEqual({ ...result, costVisible: true });
  });

  it("anyone else gets them without cost, margin or margin %", () => {
    const blind = topSellersForCaller(result, false);
    const kept = {
      productNumber: "P-1",
      name: "Lamp",
      department: "Lighting",
      vendor: "Heron",
      units: 2,
      revenue: 600,
    };
    expect(blind).toEqual({ ...result, top: [kept], bottom: [kept], costVisible: false });
  });
});
