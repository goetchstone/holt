// /app/__tests__/inventoryHealth.test.ts
//
// Pure unit tests for summarizeInventoryHealth — the row-shaping half of the
// inventory-health report (valuation, dead-stock %, sort, totals) — and for
// inventoryHealthForCaller, which strips the cost figures and the cost order for
// a viewer without "View cost". No database: the SQL half (getInventoryHealth) is
// validated against real data; this pins the math.

import {
  inventoryHealthForCaller,
  summarizeInventoryHealth,
  type InventoryHealthRawRow,
} from "@/lib/reports/inventoryHealth";

const meta = { pivot: "department" as const, staleDays: 180 };

function raw(over: Partial<InventoryHealthRawRow>): InventoryHealthRawRow {
  return {
    key: "Furniture",
    units: 0,
    cost_value: 0,
    retail_value: 0,
    dead_units: 0,
    dead_cost_value: 0,
    uncosted_units: 0,
    ...over,
  };
}

describe("summarizeInventoryHealth", () => {
  it("rounds money and derives dead-stock % of cost value", () => {
    const { rows } = summarizeInventoryHealth(
      [
        raw({
          key: "Rugs",
          units: 10,
          cost_value: 1000,
          retail_value: 2000,
          dead_units: 3,
          dead_cost_value: 250,
        }),
      ],
      meta,
    );
    expect(rows[0].costValue).toBe(1000);
    expect(rows[0].retailValue).toBe(2000);
    expect(rows[0].deadCostValue).toBe(250);
    expect(rows[0].deadPct).toBe(25); // 250 / 1000
  });

  it("returns null dead % when cost value is 0 (no divide-by-zero)", () => {
    const { rows } = summarizeInventoryHealth(
      [raw({ key: "Uncosted", units: 5, cost_value: 0 })],
      meta,
    );
    expect(rows[0].deadPct).toBeNull();
  });

  it("sorts rows by cost value, highest investment first", () => {
    const { rows } = summarizeInventoryHealth(
      [
        raw({ key: "Small", cost_value: 100 }),
        raw({ key: "Big", cost_value: 5000 }),
        raw({ key: "Mid", cost_value: 900 }),
      ],
      meta,
    );
    expect(rows.map((r) => r.key)).toEqual(["Big", "Mid", "Small"]);
  });

  it("totals units, cost, retail, dead, and uncosted across rows", () => {
    const { totals } = summarizeInventoryHealth(
      [
        raw({
          units: 10,
          cost_value: 1000,
          retail_value: 2000,
          dead_units: 2,
          dead_cost_value: 200,
          uncosted_units: 1,
        }),
        raw({
          key: "B",
          units: 5,
          cost_value: 500,
          retail_value: 900,
          dead_units: 1,
          dead_cost_value: 100,
          uncosted_units: 3,
        }),
      ],
      meta,
    );
    expect(totals.units).toBe(15);
    expect(totals.costValue).toBe(1500);
    expect(totals.retailValue).toBe(2900);
    expect(totals.deadUnits).toBe(3);
    expect(totals.deadCostValue).toBe(300);
    expect(totals.deadPct).toBe(20); // 300 / 1500
    expect(totals.uncostedUnits).toBe(4);
  });

  it("labels a null group key as Uncategorized and carries pivot + staleDays", () => {
    const result = summarizeInventoryHealth([raw({ key: null, units: 1, cost_value: 10 })], {
      pivot: "vendor",
      staleDays: 90,
    });
    expect(result.rows[0].key).toBe("Uncategorized");
    expect(result.pivot).toBe("vendor");
    expect(result.staleDays).toBe(90);
  });

  it("handles an empty snapshot (null totals %, no rows)", () => {
    const result = summarizeInventoryHealth([], meta);
    expect(result.rows).toEqual([]);
    expect(result.totals.costValue).toBe(0);
    expect(result.totals.deadPct).toBeNull();
  });
});

describe("inventoryHealthForCaller (View cost)", () => {
  // Three different orders, so the test tells them apart: by cost [Rugs,
  // Accents, Lighting], by retail [Lighting, Rugs, Accents], by name [Accents,
  // Lighting, Rugs].
  const report = summarizeInventoryHealth(
    [
      raw({
        key: "Rugs",
        units: 4,
        cost_value: 3000,
        retail_value: 5000,
        dead_units: 1,
        dead_cost_value: 600,
        uncosted_units: 1,
      }),
      raw({
        key: "Accents",
        units: 3,
        cost_value: 1000,
        retail_value: 1500,
        dead_units: 0,
        dead_cost_value: 0,
        uncosted_units: 0,
      }),
      raw({
        key: "Lighting",
        units: 10,
        cost_value: 500,
        retail_value: 8000,
        dead_units: 6,
        dead_cost_value: 300,
        uncosted_units: 2,
      }),
    ],
    meta,
  );

  it("a holder gets the report unchanged", () => {
    expect(inventoryHealthForCaller(report, true)).toEqual({ ...report, costVisible: true });
  });

  it("anyone else gets units, retail value and dead units only, ordered by retail value", () => {
    expect(report.rows.map((r) => r.key)).toEqual(["Rugs", "Accents", "Lighting"]);
    const blind = inventoryHealthForCaller(report, false);
    expect(blind.costVisible).toBe(false);
    expect(blind.pivot).toBe("department");
    expect(blind.staleDays).toBe(180);
    // toStrictEqual, so a cost key left in as undefined would fail too.
    expect(blind.rows).toStrictEqual([
      { key: "Lighting", units: 10, retailValue: 8000, deadUnits: 6 },
      { key: "Rugs", units: 4, retailValue: 5000, deadUnits: 1 },
      { key: "Accents", units: 3, retailValue: 1500, deadUnits: 0 },
    ]);
    expect(blind.totals).toStrictEqual({ units: 17, retailValue: 14500, deadUnits: 7 });
  });

  it("breaks retail-value ties by name, so groups with no retail do not keep the cost order", () => {
    // A group whose products have no baseRetail sums to NULL, which becomes 0, so
    // several groups can tie at $0 retail.
    const tied = summarizeInventoryHealth(
      [
        raw({ key: "Beds", units: 2, cost_value: 900, retail_value: null }),
        raw({ key: "Accents", units: 3, cost_value: 100, retail_value: null }),
      ],
      meta,
    );
    expect(inventoryHealthForCaller(tied, false).rows.map((r) => r.key)).toEqual([
      "Accents",
      "Beds",
    ]);
    // The holder's report is untouched: still in cost order.
    expect(tied.rows.map((r) => r.key)).toEqual(["Beds", "Accents"]);
  });

  it("orders tied names as people read them, not by code unit", () => {
    // By code unit "Beds" sorts before "accents" (capitals first), which is also
    // the cost order here; localeCompare puts "accents" first.
    const tied = summarizeInventoryHealth(
      [
        raw({ key: "Beds", cost_value: 900, retail_value: 0 }),
        raw({ key: "accents", cost_value: 100, retail_value: 0 }),
      ],
      meta,
    );
    expect(inventoryHealthForCaller(tied, false).rows.map((r) => r.key)).toEqual([
      "accents",
      "Beds",
    ]);
  });

  it("orders keys localeCompare calls equal by code unit, whichever had the higher cost", () => {
    // A soft hyphen is ignored by collation, so "So\u00ADfa" and "Sofa" tie
    // there; without a final code-unit compare they would keep the cost order.
    const blindOrder = (first: string, second: string) =>
      inventoryHealthForCaller(
        summarizeInventoryHealth(
          [
            raw({ key: first, cost_value: 400, retail_value: 1000 }),
            raw({ key: second, cost_value: 100, retail_value: 1000 }),
          ],
          meta,
        ),
        false,
      ).rows.map((r) => r.key);
    expect(blindOrder("So\u00ADfa", "Sofa")).toEqual(["Sofa", "So\u00ADfa"]);
    expect(blindOrder("Sofa", "So\u00ADfa")).toEqual(["Sofa", "So\u00ADfa"]);
  });
});
