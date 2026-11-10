// /app/__tests__/queryBuilderSummary.test.ts
//
// Grouping, totals and pivot for the query builder. The rows here are as Prisma hands
// them over, including nested relations and Decimal-like values. Which rows count is the
// database's half, in integration/queryBuilder.integration.test.ts.

import { getEntityDef, type EntityDef } from "@/lib/queryBuilderConfig";
import {
  NO_VALUE,
  measuresOf,
  parseSummaryRequest,
  summarize,
  summaryPaths,
  type SummaryRequest,
} from "@/lib/queryBuilderSummary";

const lines = getEntityDef("OrderLineItem") as EntityDef;
const poLines = getEntityDef("PurchaseOrderItem") as EntityDef;
const TZ = "America/New_York";

function request(entity: EntityDef, raw: object): SummaryRequest {
  const parsed = parseSummaryRequest(raw, entity);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.request;
}

const decimal = (value: number) => ({ toString: () => String(value) });
const row = (salesperson: string | null, netPrice: number, orderDate?: string) => ({
  netPrice: decimal(netPrice),
  salesOrder: { salesperson, orderDate: orderDate ? new Date(orderDate) : null },
});

describe("parseSummaryRequest", () => {
  it("takes groups and totals the entity offers", () => {
    const parsed = parseSummaryRequest(
      { groupBy: "salesperson", across: "orderMonth", measures: ["netPrice"] },
      lines,
    );
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["a group it doesn't offer", { groupBy: "__proto__", measures: ["count"] }, "Unknown group"],
    ["no group", { measures: ["count"] }, "Unknown group"],
    [
      "going across by something it doesn't offer",
      { groupBy: "store", across: "constructor", measures: ["count"] },
      "Unknown group",
    ],
    ["a total it doesn't offer", { groupBy: "store", measures: ["passwordHash"] }, "Unknown total"],
    ["no totals", { groupBy: "store", measures: [] }, "Pick something to total"],
    ["totals that aren't a list", { groupBy: "store", measures: "count" }, "Pick something"],
    [
      "going across by the group itself",
      { groupBy: "store", across: "store", measures: ["count"] },
      "different group",
    ],
    [
      "two totals going across",
      { groupBy: "store", across: "vendor", measures: ["count", "netPrice"] },
      "one total at a time",
    ],
  ])("refuses %s", (_what, raw, message) => {
    const parsed = parseSummaryRequest(raw, lines);
    expect(parsed).toEqual({ ok: false, error: expect.stringContaining(message) });
  });

  it("refuses what isn't an object", () => {
    expect(parseSummaryRequest("store", lines).ok).toBe(false);
    expect(parseSummaryRequest(null, lines).ok).toBe(false);
  });

  it("can't reach a total the caller's cost view took out", () => {
    const withoutCost = {
      ...lines,
      totals: { ...lines.totals, measures: lines.totals.measures.filter((m) => !m.cost) },
    };
    const parsed = parseSummaryRequest({ groupBy: "store", measures: ["cost"] }, withoutCost);
    expect(parsed.ok).toBe(false);
  });
});

describe("measuresOf", () => {
  it("offers a count first, named for what's being counted", () => {
    expect(measuresOf(lines)[0]).toMatchObject({ key: "count", label: "Lines" });
  });
});

describe("summaryPaths", () => {
  it("reads only the columns it needs", () => {
    expect(
      summaryPaths(request(poLines, { groupBy: "vendor", across: "status", measures: ["cost"] })),
    ).toEqual(["purchaseOrder.vendor.name", "purchaseOrder.status", "orderedQuantity", "unitCost"]);
    expect(summaryPaths(request(poLines, { groupBy: "vendor", measures: ["count"] }))).toEqual([
      "purchaseOrder.vendor.name",
    ]);
  });
});

describe("summarize, grouped", () => {
  const asked = request(lines, { groupBy: "salesperson", measures: ["count", "netPrice"] });

  it("adds up each group, with a total", () => {
    const table = summarize(
      [row("Sam", 100.1), row("Sam", 200.2), row("Ann", 50)],
      lines,
      asked,
      TZ,
    );
    expect(table.columns).toEqual([
      { label: "Salesperson", type: "string" },
      { label: "Lines", type: "number" },
      { label: "Net Price", type: "decimal" },
    ]);
    expect(table.rows).toEqual([
      ["Ann", 1, 50],
      ["Sam", 2, 300.3],
    ]);
    expect(table.footer).toEqual(["Total", 3, 350.3]);
    expect(table.rowsRead).toBe(3);
  });

  it("says who counts", () => {
    expect(summarize([], lines, asked, TZ).population).toBe(lines.totals.says);
  });

  it("nets a negative return line out of its group", () => {
    const table = summarize([row("Sam", 100), row("Sam", -100)], lines, asked, TZ);
    expect(table.rows).toEqual([["Sam", 2, 0]]);
  });

  it("keeps rows with no value in their own group, last, and in the total", () => {
    const table = summarize([row(null, 10), row("Zed", 20), row("", 5)], lines, asked, TZ);
    expect(table.rows).toEqual([
      ["Zed", 1, 20],
      [NO_VALUE, 2, 15],
    ]);
    expect(table.footer).toEqual(["Total", 3, 35]);
  });

  it("gets the cents right over many rows", () => {
    const many = Array.from({ length: 1000 }, () => row("Sam", 0.1));
    expect(summarize(many, lines, asked, TZ).footer).toEqual(["Total", 1000, 100]);
  });

  it("answers with an empty table when nothing counts", () => {
    const table = summarize([], lines, asked, TZ);
    expect(table.rows).toEqual([]);
    expect(table.footer).toEqual(["Total", 0, 0]);
  });
});

describe("summarize, by month", () => {
  const asked = request(lines, { groupBy: "orderMonth", measures: ["netPrice"] });

  it("files a sale under the store's month, not UTC's", () => {
    // 8pm Eastern on Oct 31 is stored as 00:00Z on Nov 1.
    const table = summarize([row("Sam", 10, "2026-11-01T00:30:00.000Z")], lines, asked, TZ);
    expect(table.rows).toEqual([["2026-10", 10]]);
  });

  it("puts months in order", () => {
    const table = summarize(
      [
        row("Sam", 1, "2026-11-15T12:00:00.000Z"),
        row("Sam", 2, "2025-12-15T12:00:00.000Z"),
        row("Sam", 3),
      ],
      lines,
      asked,
      TZ,
    );
    expect(table.rows.map((r) => r[0])).toEqual(["2025-12", "2026-11", NO_VALUE]);
  });
});

describe("summarize, pivoted", () => {
  const asked = request(lines, {
    groupBy: "salesperson",
    across: "orderMonth",
    measures: ["netPrice"],
  });
  const rows = [
    row("Sam", 100, "2026-10-15T12:00:00.000Z"),
    row("Sam", 50, "2026-11-15T12:00:00.000Z"),
    row("Ann", 25, "2026-11-15T12:00:00.000Z"),
  ];

  it("makes a column per value, with totals both ways", () => {
    const table = summarize(rows, lines, asked, TZ);
    expect(table.columns.map((c) => c.label)).toEqual([
      "Salesperson",
      "2026-10",
      "2026-11",
      "Total",
    ]);
    expect(table.rows).toEqual([
      ["Ann", 0, 25, 25],
      ["Sam", 100, 50, 150],
    ]);
    expect(table.footer).toEqual(["Total", 100, 75, 175]);
  });

  it("agrees with the same rows grouped without going across", () => {
    const flat = request(lines, { groupBy: "salesperson", measures: ["netPrice"] });
    expect(summarize(rows, lines, flat, TZ).footer[1]).toBe(
      summarize(rows, lines, asked, TZ).footer[3],
    );
  });

  it("gives rows with no value their own column", () => {
    const table = summarize([row("Sam", 5)], lines, asked, TZ);
    expect(table.columns.map((c) => c.label)).toEqual(["Salesperson", NO_VALUE, "Total"]);
  });
});

describe("a total worked out from two columns", () => {
  const asked = request(poLines, { groupBy: "product", measures: ["quantity", "cost"] });

  it("multiplies them on each row before adding", () => {
    const table = summarize(
      [
        { productName: "Sofa", orderedQuantity: decimal(2), unitCost: decimal(100.5) },
        { productName: "Sofa", orderedQuantity: decimal(1), unitCost: decimal(10) },
      ],
      poLines,
      asked,
      TZ,
    );
    expect(table.rows).toEqual([["Sofa", 3, 211]]);
  });
});

describe("a yes-or-no group", () => {
  const products = getEntityDef("Product") as EntityDef;
  const asked = request(products, { groupBy: "active", measures: ["count"] });

  it("reads as words, and false isn't mistaken for empty", () => {
    const table = summarize([{ isActive: true }, { isActive: false }], products, asked, TZ);
    expect(table.rows).toEqual([
      ["No", 1],
      ["Yes", 1],
    ]);
  });
});
