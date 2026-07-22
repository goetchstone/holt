// /app/__tests__/salesExplorerQuery.test.ts
//
// Unit tests for salesExplorerQuery.ts's invariant-bearing WHERE-clause
// builders (pure, no database) plus the product-drilldown's orphan
// normalization (getSalesExplorerItems), asserted by mocking
// lib/reports/detailedSales.ts and inspecting the exact params it's called
// with. Together with __tests__/reports.cancelledLineFilter.test.ts (which
// auto-discovers this file under lib/reports/* and asserts the literal
// `lineItemStatus: { not: "CANCELLED" }` clause is present), this pins all
// three docs/domains/reporting.md invariants for the new report:
//
//   (a) cancelled-line rule       -> "excludes CANCELLED lines" below
//   (b) nullable-column NULL trap -> "never emits a bare not:/notIn:" below
//   (c) netPrice = line total     -> enforced in computeSalesExplorerCells by
//                                     construction (no *orderedQuantity term
//                                     exists in the file); grep-pinned below.

import * as fs from "node:fs";
import * as path from "node:path";

jest.mock("@/lib/reports/detailedSales", () => ({
  getDetailedSalesItems: jest.fn().mockResolvedValue([]),
}));

import { getDetailedSalesItems } from "@/lib/reports/detailedSales";
import {
  buildSalesExplorerOrderWhere,
  buildSalesExplorerProductFilter,
  getSalesExplorerItems,
} from "@/lib/reports/salesExplorerQuery";

const mockedGetDetailedSalesItems = getDetailedSalesItems as jest.Mock;

describe("buildSalesExplorerOrderWhere", () => {
  it("includes RETURNED alongside ORDER and FULFILLED (revenue-status invariant)", () => {
    const where = buildSalesExplorerOrderWhere({}, []);
    expect(where.status).toEqual({ in: ["ORDER", "FULFILLED", "RETURNED"] });
  });

  it("builds an inclusive [start 00:00, end 23:59:59.999] window", () => {
    const where = buildSalesExplorerOrderWhere(
      { startDate: "2026-01-01", endDate: "2026-01-31" },
      [],
    );
    expect(where.orderDate).toEqual({
      gte: new Date("2026-01-01T00:00:00.000Z"),
      lte: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("uses a positive `in:` allow-list for the store filter, never a `not`", () => {
    const where = buildSalesExplorerOrderWhere({}, ["Old Saybrook", "Madison"]);
    expect(where.storeLocation).toEqual({ in: ["Old Saybrook", "Madison"] });
  });

  it("omits the store filter entirely when no stores are selected (does not drop unfiltered rows)", () => {
    const where = buildSalesExplorerOrderWhere({}, []);
    expect(where.storeLocation).toBeUndefined();
  });
});

describe("buildSalesExplorerProductFilter", () => {
  it("returns undefined when no dimension filters are active", () => {
    expect(buildSalesExplorerProductFilter([], [], [])).toBeUndefined();
  });

  it("builds an `in:` allow-list per active dimension, AND-combined by Prisma's implicit object merge", () => {
    const filter = buildSalesExplorerProductFilter(["Furniture"], ["Sofas"], ["Wesley Hall"]);
    expect(filter).toEqual({
      department: { name: { in: ["Furniture"] } },
      category: { name: { in: ["Sofas"] } },
      vendor: { name: { in: ["Wesley Hall"] } },
    });
  });

  it("omits a dimension's clause when that filter array is empty", () => {
    const filter = buildSalesExplorerProductFilter(["Furniture"], [], []);
    expect(filter).toEqual({ department: { name: { in: ["Furniture"] } } });
  });
});

describe("getSalesExplorerItems — orphan sentinel normalization", () => {
  beforeEach(() => mockedGetDetailedSalesItems.mockClear());

  it("passes real department/category/vendor names straight through unmodified", async () => {
    await getSalesExplorerItems({} as never, {
      store: "Old Saybrook",
      department: "Furniture",
      category: "Sofas",
      vendor: "Wesley Hall",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(mockedGetDetailedSalesItems).toHaveBeenCalledWith(
      {},
      {
        store: "Old Saybrook",
        department: "Furniture",
        category: "Sofas",
        vendor: "Wesley Hall",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
    );
  });

  it("normalizes department === Uncategorized to the orphan branch, dropping category/vendor", async () => {
    await getSalesExplorerItems({} as never, {
      department: "Uncategorized",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(mockedGetDetailedSalesItems).toHaveBeenCalledWith(
      {},
      {
        store: undefined,
        department: "Uncategorized",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
    );
  });

  it("normalizes category === (No Category) to the orphan branch even without department set (Category/Vendor pivots)", async () => {
    await getSalesExplorerItems({} as never, {
      category: "(No Category)",
      vendor: "Unknown Vendor",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(mockedGetDetailedSalesItems).toHaveBeenCalledWith(
      {},
      {
        store: undefined,
        department: "Uncategorized",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
    );
  });

  it("normalizes vendor === Unknown Vendor to the orphan branch", async () => {
    await getSalesExplorerItems({} as never, {
      department: "Furniture",
      vendor: "Unknown Vendor",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(mockedGetDetailedSalesItems).toHaveBeenCalledWith(
      {},
      {
        store: undefined,
        department: "Uncategorized",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
    );
  });
});

describe("source-text invariant pins (lib/reports/salesExplorerQuery.ts)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "lib", "reports", "salesExplorerQuery.ts"),
    "utf8",
  );

  it("(a) excludes CANCELLED lines with the canonical literal clause", () => {
    expect(src).toMatch(/lineItemStatus:\s*\{\s*not:\s*"CANCELLED"\s*\}/);
  });

  it("(b) never filters a nullable column with a bare not:/notIn: (only positive `in:` allow-lists)", () => {
    // Regexes require the CODE shape (`notIn: [` / `storeLocation: { not`), not
    // just the substring, so they don't false-positive on this file's own
    // prose explaining the NULL-trap rule (which mentions `notIn:` by name).
    expect(src).not.toMatch(/storeLocation:\s*\{\s*not/);
    expect(src).not.toMatch(/\bnotIn:\s*\[/);
  });

  it("(c) never multiplies netPrice by orderedQuantity", () => {
    expect(src).not.toMatch(/netPrice\s*\*\s*.*[Qq]uantity/);
    expect(src).not.toMatch(/[Qq]uantity.*\*\s*.*netPrice/i);
  });

  it("uses the canonical SALES_REVENUE_STATUSES constant rather than a hand-rolled status list", () => {
    expect(src).toMatch(/SALES_REVENUE_STATUSES/);
  });
});
