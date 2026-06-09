// /app/src/lib/reports/inventoryHealth.ts
//
// Inventory health: on-hand units, value at cost and retail, and dead stock by
// department or vendor. Dead stock = on-hand units whose product hasn't sold
// within staleDays (never-sold counts as dead). Aggregated in the DB (GROUP BY;
// P2029-safe); cutoff is a bound timestamp, pivot a validated enum. Rule 33: the
// last-sold lookup excludes cancelled OrderLineItem rows (SalesOrder.lineItems) so
// a cancelled line can't make stale stock look alive. baseCost is missing on ~17%
// of products — uncostedUnits surfaces that valuation blind spot.

import type { PrismaClient } from "@prisma/client";

export const INVENTORY_PIVOTS = ["department", "vendor"] as const;
export type InventoryPivot = (typeof INVENTORY_PIVOTS)[number];

// 180 days (6 months): furniture turns slowly, so a 6-month no-sale window is the
// conventional "aged inventory" line. Grounded in a real-data sample (2026-06-05):
// of 13,241 on-hand products, 2,483 had no sale in 180d plus 5,196 never sold.
export const DEFAULT_STALE_DAYS = 180;

export interface InventoryHealthRow {
  key: string; // department or vendor name
  units: number;
  costValue: number;
  retailValue: number;
  deadUnits: number;
  deadCostValue: number;
  deadPct: number | null; // deadCostValue / costValue * 100; null when costValue 0
  uncostedUnits: number; // on-hand units with no baseCost (valuation blind spot)
}

export interface InventoryHealthTotals {
  units: number;
  costValue: number;
  retailValue: number;
  deadUnits: number;
  deadCostValue: number;
  deadPct: number | null;
  uncostedUnits: number;
}

export interface InventoryHealthResult {
  pivot: InventoryPivot;
  staleDays: number;
  rows: InventoryHealthRow[];
  totals: InventoryHealthTotals;
}

export interface InventoryHealthInput {
  pivot?: InventoryPivot;
  staleDays?: number;
}

// Exported so the pure summarizer can be tested against realistic input rows
// without a database.
export interface InventoryHealthRawRow {
  key: string | null;
  units: number;
  cost_value: number | null;
  retail_value: number | null;
  dead_units: number | null;
  dead_cost_value: number | null;
  uncosted_units: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (part: number, whole: number): number | null =>
  whole > 0 ? round2((part / whole) * 100) : null;

export async function getInventoryHealth(
  prisma: PrismaClient,
  input: InventoryHealthInput,
): Promise<InventoryHealthResult> {
  const pivot: InventoryPivot = input.pivot === "vendor" ? "vendor" : "department";
  const staleDays =
    typeof input.staleDays === "number" && input.staleDays > 0
      ? Math.floor(input.staleDays)
      : DEFAULT_STALE_DAYS;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - staleDays);
  const cutoffIso = cutoff.toISOString();

  const rows =
    pivot === "vendor"
      ? await prisma.$queryRaw<InventoryHealthRawRow[]>`
          WITH lastsold AS (
            SELECT li."productId", MAX(so."orderDate") AS last_sold
            FROM "OrderLineItem" li
            JOIN "SalesOrder" so ON so.id = li."salesOrderId"
            WHERE li."lineItemStatus" <> 'CANCELLED'
            GROUP BY li."productId"
          )
          SELECT COALESCE(v.name, 'No Vendor') AS key,
                 SUM(ip.quantity)::float8 AS units,
                 SUM(ip.quantity * p."baseCost")::float8 AS cost_value,
                 SUM(ip.quantity * p."baseRetail")::float8 AS retail_value,
                 SUM(ip.quantity) FILTER (
                   WHERE ls.last_sold IS NULL OR ls.last_sold < ${cutoffIso}::timestamptz
                 )::float8 AS dead_units,
                 SUM(ip.quantity * p."baseCost") FILTER (
                   WHERE ls.last_sold IS NULL OR ls.last_sold < ${cutoffIso}::timestamptz
                 )::float8 AS dead_cost_value,
                 SUM(ip.quantity) FILTER (
                   WHERE p."baseCost" IS NULL OR p."baseCost" = 0
                 )::float8 AS uncosted_units
          FROM "InventoryPosition" ip
          JOIN "Product" p ON p.id = ip."productId"
          LEFT JOIN "Vendor" v ON v.id = p."vendorId"
          LEFT JOIN lastsold ls ON ls."productId" = ip."productId"
          WHERE ip.quantity > 0
          GROUP BY 1
        `
      : await prisma.$queryRaw<InventoryHealthRawRow[]>`
          WITH lastsold AS (
            SELECT li."productId", MAX(so."orderDate") AS last_sold
            FROM "OrderLineItem" li
            JOIN "SalesOrder" so ON so.id = li."salesOrderId"
            WHERE li."lineItemStatus" <> 'CANCELLED'
            GROUP BY li."productId"
          )
          SELECT COALESCE(d.name, 'Uncategorized') AS key,
                 SUM(ip.quantity)::float8 AS units,
                 SUM(ip.quantity * p."baseCost")::float8 AS cost_value,
                 SUM(ip.quantity * p."baseRetail")::float8 AS retail_value,
                 SUM(ip.quantity) FILTER (
                   WHERE ls.last_sold IS NULL OR ls.last_sold < ${cutoffIso}::timestamptz
                 )::float8 AS dead_units,
                 SUM(ip.quantity * p."baseCost") FILTER (
                   WHERE ls.last_sold IS NULL OR ls.last_sold < ${cutoffIso}::timestamptz
                 )::float8 AS dead_cost_value,
                 SUM(ip.quantity) FILTER (
                   WHERE p."baseCost" IS NULL OR p."baseCost" = 0
                 )::float8 AS uncosted_units
          FROM "InventoryPosition" ip
          JOIN "Product" p ON p.id = ip."productId"
          LEFT JOIN "Department" d ON d.id = p."departmentId"
          LEFT JOIN lastsold ls ON ls."productId" = ip."productId"
          WHERE ip.quantity > 0
          GROUP BY 1
        `;

  return summarizeInventoryHealth(rows, { pivot, staleDays });
}

/**
 * Shape raw GROUP BY rows into the inventory-health result: round money, derive
 * dead-stock %, sort by cost value (where the money sits), and total the snapshot.
 * Pure — no I/O — so every branch is unit-tested without a database.
 */
export function summarizeInventoryHealth(
  rows: InventoryHealthRawRow[],
  meta: { pivot: InventoryPivot; staleDays: number },
): InventoryHealthResult {
  const mapped: InventoryHealthRow[] = rows.map((r) => {
    const costValue = round2(Number(r.cost_value) || 0);
    const deadCostValue = round2(Number(r.dead_cost_value) || 0);
    return {
      key: r.key ?? "Uncategorized",
      units: Math.round(Number(r.units) || 0),
      costValue,
      retailValue: round2(Number(r.retail_value) || 0),
      deadUnits: Math.round(Number(r.dead_units) || 0),
      deadCostValue,
      deadPct: pctOf(deadCostValue, costValue),
      uncostedUnits: Math.round(Number(r.uncosted_units) || 0),
    };
  });

  // Sort by cost value, descending (largest tied-up capital first).
  mapped.sort((a, b) => b.costValue - a.costValue);

  const sums = mapped.reduce(
    (acc, r) => {
      acc.units += r.units;
      acc.costValue += r.costValue;
      acc.retailValue += r.retailValue;
      acc.deadUnits += r.deadUnits;
      acc.deadCostValue += r.deadCostValue;
      acc.uncostedUnits += r.uncostedUnits;
      return acc;
    },
    { units: 0, costValue: 0, retailValue: 0, deadUnits: 0, deadCostValue: 0, uncostedUnits: 0 },
  );
  const totalCost = round2(sums.costValue);
  const totalDeadCost = round2(sums.deadCostValue);

  return {
    pivot: meta.pivot,
    staleDays: meta.staleDays,
    rows: mapped,
    totals: {
      units: sums.units,
      costValue: totalCost,
      retailValue: round2(sums.retailValue),
      deadUnits: sums.deadUnits,
      deadCostValue: totalDeadCost,
      deadPct: pctOf(totalDeadCost, totalCost),
      uncostedUnits: sums.uncostedUnits,
    },
  };
}
