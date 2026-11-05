// /app/src/lib/reports/inventoryValue.ts
//
// Inventory Value (GAP-17): what was on the books at the end of a past day,
// read back from the journal (StockMovement), for the whole business or one
// store.
//
// QUANTITIES ARE THE JOURNAL'S. VALUES ARE TODAY'S.
//
// Holt keeps no history of a product's cost, and a freeze holds none either, so
// a past quantity can only be priced at today's cost. The screen says so wherever
// it shows the number. It answers "how much stock did we hold, in today's money",
// not "what did the balance sheet say that day". Same for retail.
//
// POPULATION
//
// The same as Inventory Health: every unit on the books, committed or free,
// including stock in transit, which sits in a transit place. So the value as of
// today is Inventory Health's cost value, and a test holds them to it.
//
// A DATE THE JOURNAL CAN'T ANSWER
//
// Before the journal's first movement there's no record, which isn't the same as
// no stock, so that date gets `beforeJournal` and no numbers rather than a zero.
// A future date is refused: it would only repeat today under a date that hasn't
// happened.
//
// occurredAt is when Holt was told. A receipt entered a day late counts from the
// day it was entered.
//
// Cost goes only to a holder of "View cost" (inventoryValueForCaller).

import { Prisma, type PrismaClient } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { productCostSql } from "@/lib/purchasing/landedCost";
import { businessDayKey, businessDayRange, isDayKey } from "@/lib/reports/businessDay";
import { type InventoryPivot } from "@/lib/reports/inventoryHealth";

const UNIT_COST = Prisma.raw(productCostSql("p"));

export interface InventoryValueRow {
  key: string;
  units: number;
  costValue: number;
  retailValue: number;
  uncostedUnits: number;
}

export type InventoryValueTotals = Omit<InventoryValueRow, "key">;

export interface InventoryValueResult {
  asOf: string;
  isToday: boolean;
  pivot: InventoryPivot;
  storeLocationId: number | null;
  /** The store day of the journal's first movement; null when nothing has moved. */
  journalStartsOn: string | null;
  /** The date is before the journal: nothing can be said, and rows are empty. */
  beforeJournal: boolean;
  rows: InventoryValueRow[];
  totals: InventoryValueTotals;
}

/** A date this report can't be run for. The router answers 400 with the message. */
export class InventoryValueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValueInputError";
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const NO_TOTALS: InventoryValueTotals = {
  units: 0,
  costValue: 0,
  retailValue: 0,
  uncostedUnits: 0,
};

const PIVOT_KEY: Record<InventoryPivot, Prisma.Sql> = {
  department: Prisma.sql`COALESCE(d.name, 'Uncategorized')`,
  vendor: Prisma.sql`COALESCE(v.name, 'No Vendor')`,
};

export async function getInventoryValue(
  prisma: PrismaClient,
  input: { asOf?: string; pivot?: InventoryPivot; storeLocationId?: number | null },
): Promise<InventoryValueResult> {
  const timeZone = await getBusinessTimeZone();
  const today = businessDayKey(new Date(), timeZone);
  const asOf = input.asOf ?? today;
  if (!isDayKey(asOf)) throw new InventoryValueInputError("Choose a date as YYYY-MM-DD.");
  if (asOf > today) throw new InventoryValueInputError("Choose today or a date before it.");

  const pivot: InventoryPivot = input.pivot === "vendor" ? "vendor" : "department";
  const storeLocationId = input.storeLocationId ?? null;

  const [{ first }] = await prisma.$queryRaw<{ first: Date | null }[]>`
    SELECT MIN("occurredAt") AS first FROM "StockMovement"
  `;
  const journalStartsOn = first ? businessDayKey(first, timeZone) : null;
  const base = { asOf, isToday: asOf === today, pivot, storeLocationId, journalStartsOn };
  if (journalStartsOn && asOf < journalStartsOn) {
    return { ...base, beforeJournal: true, rows: [], totals: NO_TOTALS };
  }

  const end = businessDayRange(asOf, timeZone).lt;
  const raw = await prisma.$queryRaw<
    {
      key: string;
      units: number | null;
      cost_value: number | null;
      retail_value: number | null;
      uncosted_units: number | null;
    }[]
  >`
    WITH legs AS (
      SELECT "productId", "toStoreLocationId" AS s, quantity AS q
      FROM "StockMovement"
      WHERE "toStoreLocationId" IS NOT NULL AND "occurredAt" < ${end}
      UNION ALL
      SELECT "productId", "fromStoreLocationId", -quantity
      FROM "StockMovement"
      WHERE "fromStoreLocationId" IS NOT NULL AND "occurredAt" < ${end}
    ),
    held AS (
      SELECT "productId", s, SUM(q) AS q
      FROM legs
      WHERE (${storeLocationId}::int IS NULL OR s = ${storeLocationId}::int)
      GROUP BY "productId", s
      HAVING SUM(q) <> 0
    )
    SELECT ${PIVOT_KEY[pivot]} AS key,
           SUM(h.q)::float8 AS units,
           SUM(h.q * ${UNIT_COST})::float8 AS cost_value,
           SUM(h.q * p."baseRetail")::float8 AS retail_value,
           SUM(h.q) FILTER (WHERE ${UNIT_COST} IS NULL OR ${UNIT_COST} = 0)::float8
             AS uncosted_units
    FROM held h
    JOIN "Product" p ON p.id = h."productId"
    LEFT JOIN "Department" d ON d.id = p."departmentId"
    LEFT JOIN "Vendor" v ON v.id = p."vendorId"
    GROUP BY 1
  `;

  const rows: InventoryValueRow[] = raw
    .map((r) => ({
      key: r.key,
      units: round3(Number(r.units) || 0),
      costValue: round2(Number(r.cost_value) || 0),
      retailValue: round2(Number(r.retail_value) || 0),
      uncostedUnits: round3(Number(r.uncosted_units) || 0),
    }))
    .sort((a, b) => b.costValue - a.costValue || a.key.localeCompare(b.key));

  const totals = rows.reduce<InventoryValueTotals>(
    (sum, r) => ({
      units: round3(sum.units + r.units),
      costValue: round2(sum.costValue + r.costValue),
      retailValue: round2(sum.retailValue + r.retailValue),
      uncostedUnits: round3(sum.uncostedUnits + r.uncostedUnits),
    }),
    NO_TOTALS,
  );

  return { ...base, beforeJournal: false, rows, totals };
}

type CostField = "costValue" | "uncostedUnits";

export interface InventoryValueForCaller extends Omit<InventoryValueResult, "rows" | "totals"> {
  rows: Omit<InventoryValueRow, CostField>[];
  totals: Omit<InventoryValueTotals, CostField>;
}

/**
 * The report for one viewer: whole for a holder of "View cost"; units and retail
 * value for anyone else, in retail order (then name), because cost order alone
 * would give the ranking away.
 */
export function inventoryValueForCaller(
  result: InventoryValueResult,
  showCost: boolean,
): (InventoryValueResult | InventoryValueForCaller) & { costVisible: boolean } {
  if (showCost) return { ...result, costVisible: true };
  return {
    ...result,
    rows: [...result.rows]
      .sort((a, b) => b.retailValue - a.retailValue || a.key.localeCompare(b.key))
      .map((r) => ({ key: r.key, units: r.units, retailValue: r.retailValue })),
    totals: { units: result.totals.units, retailValue: result.totals.retailValue },
    costVisible: false,
  };
}
