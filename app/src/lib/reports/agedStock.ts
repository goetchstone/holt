// /app/src/lib/reports/agedStock.ts
//
// Aged Stock (GAP-17): how long uncommitted stock has been here, counted from
// when it came onto the books. Inventory Health's "dead stock" answers a
// different question, how long since a product last sold, and the two disagree
// on purpose: a sofa received last week that has never sold is dead by that
// measure and new by this one.
//
// HOW OLD IS A UNIT?
//
// The journal (StockMovement) says when units came in, not which unit is which,
// so this assumes what a store tries to do: the oldest sell first. Then what is
// still here is the newest units in, and a product's age comes from walking its
// arrivals newest first until they cover what's on hand (layersOnHand).
//
// What counts as an arrival is AGE_EFFECT, one line per journal reason, so a new
// reason can't compile without saying what it does to age. Moving stock between
// places doesn't restart its age. Coming back from a customer does, and so does
// a count finding more, because that's the only date the books have for them.
//
// HOW FAR THE CLAIM GOES
//
// An opening balance or an import only says when Holt first heard of the stock,
// so those units are "at least" that old (atLeastUnits). Units no arrival covers
// are reported as having no record (noRecordUnits), not given a guessed age.
//
// POPULATION
//
// Stock on the books with no customer's name on it: no sales order, and not in a
// place that holds customers' stock (the same two owner signals as free stock,
// lib/inventory/allocation.ts). It deliberately keeps display pieces, quarantine,
// returns and stock on a truck or in transit, which aren't for sale right now
// and can still be old. Committed units are sold, so they're left out and counted
// in committedUnits, and the two add up to Inventory Health's units on hand.
//
// Cost goes only to a holder of "View cost" (agedStockForCaller).

import { Prisma, type PrismaClient } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { AGE_BUCKETS, ageBucketIndex } from "@/lib/reports/agedStockShared";
import type { MovementReason } from "@/lib/inventory/ledger";
import { QTY_EPSILON, roundQty } from "@/lib/inventory/quantity";
import { productCostSql } from "@/lib/purchasing/landedCost";
import { type InventoryPivot } from "@/lib/reports/inventoryHealth";
import { businessDayKey, daysBetween } from "@/lib/reports/businessDay";

const UNIT_COST = Prisma.raw(productCostSql("p"));

/**
 * What a journal reason does to the age of the units it moves:
 *   starts   units coming onto the books from outside begin their age here;
 *   cancels  takes back an earlier arrival of the same kind, as if it never was;
 *   none     moves stock or takes it away, and says nothing about age.
 *
 * UNDELIVER is "none" because the units never really left. It and the DELIVER it
 * undoes both say nothing, so the units keep the arrival they already had.
 */
export const AGE_EFFECT: Record<MovementReason, "starts" | "cancels" | "none"> = {
  OPENING: "starts",
  RECEIVE: "starts",
  RETURN: "starts",
  ADJUST: "starts",
  IMPORT_SYNC: "starts",
  UNRECEIVE: "cancels",
  ALLOCATE: "none",
  RELEASE: "none",
  DELIVER: "none",
  UNDELIVER: "none",
  WRITE_OFF: "none",
  DAMAGE: "none",
  TRANSFER: "none",
};

const reasonsWithEffect = (effect: "starts" | "cancels"): string[] =>
  Object.entries(AGE_EFFECT)
    .filter(([, e]) => e === effect)
    .map(([reason]) => reason);

/** These only say when Holt first heard of the stock, not when it arrived. */
const HEARD_OF_ONLY: ReadonlySet<MovementReason> = new Set(["OPENING", "IMPORT_SYNC"]);

/** How a unit came to be here, as the report says it. */
export const ARRIVAL_LABELS: Partial<Record<MovementReason, string>> = {
  OPENING: "Opening balance",
  RECEIVE: "Received",
  RETURN: "Returned",
  ADJUST: "Found in a count",
  IMPORT_SYNC: "Imported",
};

export interface JournalArrival {
  reason: MovementReason;
  quantity: number;
  occurredAt: Date;
}

export interface AgeLayer extends JournalArrival {
  /** How many of this arrival's units are taken to be the ones still here. */
  units: number;
}

/**
 * The arrivals that account for `onHand` units, oldest-sold-first. Takes the
 * journal rows NEWEST first. A receipt taken back cancels the receipt before it,
 * or stock that arrived months ago would look a day old because of a mistake
 * corrected yesterday. Pure: every branch is tested without a database.
 */
export function layersOnHand(
  onHand: number,
  newestFirst: readonly JournalArrival[],
): { layers: AgeLayer[]; noRecord: number } {
  let left = onHand;
  let takenBack = 0;
  const layers: AgeLayer[] = [];
  for (const row of newestFirst) {
    if (left <= QTY_EPSILON) break;
    if (AGE_EFFECT[row.reason] === "cancels") {
      takenBack = roundQty(takenBack + row.quantity);
      continue;
    }
    let available = row.quantity;
    if (row.reason === "RECEIVE" && takenBack > 0) {
      const cancelled = Math.min(takenBack, available);
      takenBack = roundQty(takenBack - cancelled);
      available = roundQty(available - cancelled);
    }
    if (available <= QTY_EPSILON) continue;
    const units = Math.min(available, left);
    layers.push({ ...row, units });
    left = roundQty(left - units);
  }
  return { layers, noRecord: left > QTY_EPSILON ? left : 0 };
}

export interface AgedBucket {
  units: number;
  retailValue: number;
  costValue: number;
}

export interface AgedStockGroup {
  units: number;
  retailValue: number;
  costValue: number;
  uncostedUnits: number;
  /** One per AGE_BUCKETS, in order. */
  buckets: AgedBucket[];
  /** Units dated by an opening balance or import: at least this old. */
  atLeastUnits: number;
  /** Units no arrival accounts for, in no bucket. */
  noRecordUnits: number;
}

export interface AgedStockRow extends AgedStockGroup {
  key: string;
}

export interface AgedProduct {
  productId: number;
  productNumber: string;
  name: string;
  units: number;
  /** The oldest arrival that still counts toward what's here. */
  oldestOn: string;
  oldestDays: number;
  arrival: string;
  atLeast: boolean;
  retailValue: number;
  costValue: number;
}

export interface AgedStockResult {
  pivot: InventoryPivot;
  rows: AgedStockRow[];
  totals: AgedStockGroup;
  /** Sold and waiting to leave: on the books, not in this report. */
  committedUnits: number;
  /** The oldest products, oldest first (AGED_PRODUCT_LIMIT of productCount). */
  oldest: AgedProduct[];
  productCount: number;
}

export const AGED_PRODUCT_LIMIT = 100;

const round2 = (n: number) => Math.round(n * 100) / 100;

function emptyGroup(): AgedStockGroup {
  return {
    units: 0,
    retailValue: 0,
    costValue: 0,
    uncostedUnits: 0,
    buckets: AGE_BUCKETS.map(() => ({ units: 0, retailValue: 0, costValue: 0 })),
    atLeastUnits: 0,
    noRecordUnits: 0,
  };
}

/** A product's stock, as the query reads it. */
export interface AgedStockProduct {
  productId: number;
  productNumber: string;
  name: string;
  group: string;
  units: number;
  unitCost: number | null;
  unitRetail: number | null;
}

function addToGroup(
  group: AgedStockGroup,
  product: AgedStockProduct,
  layers: readonly AgeLayer[],
  noRecord: number,
  today: string,
  timeZone: string,
): void {
  const cost = product.unitCost ?? 0;
  const retail = product.unitRetail ?? 0;
  group.units = roundQty(group.units + product.units);
  group.retailValue += product.units * retail;
  group.costValue += product.units * cost;
  if (!cost) group.uncostedUnits = roundQty(group.uncostedUnits + product.units);
  group.noRecordUnits = roundQty(group.noRecordUnits + noRecord);
  for (const layer of layers) {
    const days = daysBetween(businessDayKey(layer.occurredAt, timeZone), today);
    const bucket = group.buckets[ageBucketIndex(days)];
    bucket.units = roundQty(bucket.units + layer.units);
    bucket.retailValue += layer.units * retail;
    bucket.costValue += layer.units * cost;
    if (HEARD_OF_ONLY.has(layer.reason)) {
      group.atLeastUnits = roundQty(group.atLeastUnits + layer.units);
    }
  }
}

function roundGroup<T extends AgedStockGroup>(group: T): T {
  return {
    ...group,
    retailValue: round2(group.retailValue),
    costValue: round2(group.costValue),
    buckets: group.buckets.map((b) => ({
      units: b.units,
      retailValue: round2(b.retailValue),
      costValue: round2(b.costValue),
    })),
  };
}

function agedProduct(
  product: AgedStockProduct,
  oldest: AgeLayer,
  today: string,
  timeZone: string,
): AgedProduct {
  const oldestOn = businessDayKey(oldest.occurredAt, timeZone);
  return {
    productId: product.productId,
    productNumber: product.productNumber,
    name: product.name,
    units: product.units,
    oldestOn,
    oldestDays: daysBetween(oldestOn, today),
    arrival: ARRIVAL_LABELS[oldest.reason] ?? oldest.reason,
    atLeast: HEARD_OF_ONLY.has(oldest.reason),
    retailValue: round2(product.units * (product.unitRetail ?? 0)),
    costValue: round2(product.units * (product.unitCost ?? 0)),
  };
}

/**
 * Shape products and their arrivals into the report. Pure: `arrivals` holds each
 * product's journal rows newest first, and `today` is the store's day.
 */
export function summarizeAgedStock(
  products: readonly AgedStockProduct[],
  arrivals: ReadonlyMap<number, readonly JournalArrival[]>,
  meta: { pivot: InventoryPivot; today: string; timeZone: string; committedUnits: number },
): AgedStockResult {
  const groups = new Map<string, AgedStockGroup>();
  const totals = emptyGroup();
  const aged: AgedProduct[] = [];

  for (const product of products) {
    const { layers, noRecord } = layersOnHand(product.units, arrivals.get(product.productId) ?? []);
    const group = groups.get(product.group) ?? emptyGroup();
    groups.set(product.group, group);
    addToGroup(group, product, layers, noRecord, meta.today, meta.timeZone);
    addToGroup(totals, product, layers, noRecord, meta.today, meta.timeZone);
    const oldest = layers.at(-1);
    if (oldest) aged.push(agedProduct(product, oldest, meta.today, meta.timeZone));
  }

  const rows = [...groups.entries()]
    .map(([key, group]) => roundGroup({ ...group, key }))
    .sort((a, b) => b.costValue - a.costValue || a.key.localeCompare(b.key));

  aged.sort(
    (a, b) => b.oldestDays - a.oldestDays || b.units - a.units || a.name.localeCompare(b.name),
  );

  return {
    pivot: meta.pivot,
    rows,
    totals: roundGroup(totals),
    committedUnits: meta.committedUnits,
    oldest: aged.slice(0, AGED_PRODUCT_LIMIT),
    productCount: products.length,
  };
}

const PIVOT_KEY: Record<InventoryPivot, Prisma.Sql> = {
  department: Prisma.sql`COALESCE(d.name, 'Uncategorized')`,
  vendor: Prisma.sql`COALESCE(v.name, 'No Vendor')`,
};

export async function getAgedStock(
  prisma: PrismaClient,
  input: { pivot?: InventoryPivot },
): Promise<AgedStockResult> {
  const pivot: InventoryPivot = input.pivot === "vendor" ? "vendor" : "department";
  const timeZone = await getBusinessTimeZone();
  const today = businessDayKey(new Date(), timeZone);

  const stock = await prisma.$queryRaw<
    (Omit<AgedStockProduct, "units"> & { units: number | null; committed: number | null })[]
  >`
    SELECT p.id AS "productId", p."productNumber", p.name,
           ${PIVOT_KEY[pivot]} AS "group",
           SUM(ip.quantity) FILTER (
             WHERE ip."salesOrderId" IS NULL AND NOT sl."holdsCommittedStock"
           )::float8 AS units,
           SUM(ip.quantity) FILTER (
             WHERE ip."salesOrderId" IS NOT NULL OR sl."holdsCommittedStock"
           )::float8 AS committed,
           (${UNIT_COST})::float8 AS "unitCost",
           p."baseRetail"::float8 AS "unitRetail"
    FROM "InventoryPosition" ip
    JOIN "StockLocation" sl ON sl.id = ip."stockLocationId"
    JOIN "Product" p ON p.id = ip."productId"
    LEFT JOIN "Department" d ON d.id = p."departmentId"
    LEFT JOIN "Vendor" v ON v.id = p."vendorId"
    GROUP BY p.id, d.name, v.name
  `;

  const products: AgedStockProduct[] = stock
    .filter((s) => (s.units ?? 0) > 0)
    .map((s) => ({ ...s, units: roundQty(s.units ?? 0) }));
  const committedUnits = roundQty(stock.reduce((sum, s) => sum + (s.committed ?? 0), 0));

  const rows = products.length
    ? await prisma.$queryRaw<(JournalArrival & { productId: number })[]>`
        SELECT "productId", reason, quantity::float8 AS quantity, "occurredAt"
        FROM "StockMovement"
        WHERE "productId" = ANY(${products.map((p) => p.productId)}::int[])
          AND (
            ("fromStoreLocationId" IS NULL AND reason = ANY(${reasonsWithEffect("starts")}::text[]))
            OR reason = ANY(${reasonsWithEffect("cancels")}::text[])
          )
        ORDER BY "productId", "occurredAt" DESC, id DESC
      `
    : [];

  const arrivals = new Map<number, JournalArrival[]>();
  for (const row of rows) {
    const list = arrivals.get(row.productId) ?? [];
    list.push(row);
    arrivals.set(row.productId, list);
  }

  return summarizeAgedStock(products, arrivals, { pivot, today, timeZone, committedUnits });
}

type CostFree<T> = Omit<T, "costValue" | "uncostedUnits" | "buckets"> & {
  buckets: Omit<AgedBucket, "costValue">[];
};

export interface AgedStockForCaller extends Omit<AgedStockResult, "rows" | "totals" | "oldest"> {
  rows: CostFree<AgedStockRow>[];
  totals: CostFree<AgedStockGroup>;
  oldest: Omit<AgedProduct, "costValue">[];
}

function withoutCost(group: AgedStockGroup): CostFree<AgedStockGroup> {
  return {
    units: group.units,
    retailValue: group.retailValue,
    atLeastUnits: group.atLeastUnits,
    noRecordUnits: group.noRecordUnits,
    buckets: group.buckets.map(({ units, retailValue }) => ({ units, retailValue })),
  };
}

/**
 * The report for one viewer: whole for a holder of "View cost", without cost for
 * anyone else. Rows are put back in retail order (then name) for them, because
 * cost order alone would give the ranking away. The oldest list needs no
 * re-sorting: it never looks at cost.
 */
export function agedStockForCaller(
  result: AgedStockResult,
  showCost: boolean,
): (AgedStockResult | AgedStockForCaller) & { costVisible: boolean } {
  if (showCost) return { ...result, costVisible: true };
  const rows = [...result.rows]
    .sort((a, b) => b.retailValue - a.retailValue || a.key.localeCompare(b.key))
    .map((row) => ({ key: row.key, ...withoutCost(row) }));
  return {
    ...result,
    rows,
    totals: withoutCost(result.totals),
    oldest: result.oldest.map((p) => ({
      productId: p.productId,
      productNumber: p.productNumber,
      name: p.name,
      units: p.units,
      oldestOn: p.oldestOn,
      oldestDays: p.oldestDays,
      arrival: p.arrival,
      atLeast: p.atLeast,
      retailValue: p.retailValue,
    })),
    costVisible: false,
  };
}
