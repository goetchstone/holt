// /app/__tests__/inventoryHealth.test.ts
//
// Pure unit tests for summarizeInventoryHealth — the row-shaping half of the
// inventory-health report (valuation, dead-stock %, sort, totals). No database:
// the SQL half (getInventoryHealth) is validated against real data; this pins the
// math.

import {
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
