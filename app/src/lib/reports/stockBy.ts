// /app/src/lib/reports/stockBy.ts
//
// Stock and space by any field (ledger plan phase 13). One report: pick what
// to look inside -- everything, a store, or any place (a building, a bay) --
// then group what is there by the places directly inside it, by place type, or
// by a product field. Units are summed; floor space is split across them.
//
// Space: each unit counts toward its NEAREST MEASURED place (itself, or the
// closest place above it with square footage). Each measured place's square
// footage is split across the units that count toward it, by unit share
// (v1; by product footprint once enough products carry dimensions, rule 41).
// A measured place with nothing in it is "Empty space"; units with no measured
// place above them are "Unmeasured units". Only places inside the scope are
// split: a measured building above the bay you are looking inside is not
// divided among the bay's units, so they read as unmeasured.
//
// A measured place inside another measured place counts the same floor twice
// (the outer place's footage is split over the units in its unmeasured parts
// as if it were all theirs), so it is reported as a setup warning.
//
// Every unit Holt owns is counted, committed or free: a sold sofa still takes
// up floor until it leaves. The fields one can group by are one catalog
// (rule 37).

import type { Prisma, PrismaClient } from "@prisma/client";
import { ancestry, descendantIds, type PlaceNode } from "@/lib/inventory/placeTree";
import { LOCATION_TYPE_INFO, isStockLocationType } from "@/lib/inventory/locationTypes";
import { roundQty, toQty } from "@/lib/inventory/quantity";

type Db = PrismaClient | Prisma.TransactionClient;

export const STOCK_BY_FIELDS = {
  place: "Places inside it",
  placeType: "Place type",
  department: "Department",
  category: "Category",
  type: "Type",
  vendor: "Vendor",
  collection: "Collection",
} as const;

export type StockByField = keyof typeof STOCK_BY_FIELDS;

export function isStockByField(value: unknown): value is StockByField {
  return typeof value === "string" && Object.hasOwn(STOCK_BY_FIELDS, value);
}

export const EMPTY_SPACE = "Empty space";
export const UNMEASURED = "Unmeasured units";

export interface UnitAtPlace {
  placeId: number;
  group: string;
  units: number;
}

export interface SpaceRow {
  group: string;
  units: number;
  squareFeet: number;
}

/** A measured place inside another measured place. */
export interface DoubleCount {
  placeId: number;
  insideId: number;
}

type MeasuredPlace = PlaceNode & { squareFootage: number | null };

const addTo = (map: Map<string, number>, key: string, n: number) =>
  map.set(key, roundQty((map.get(key) ?? 0) + n));

const sumOf = (map: Map<string, number>) => [...map.values()].reduce((s, n) => s + n, 0);

/** Units per group, and per group at each measured place they count toward. */
function tallyUnits(units: UnitAtPlace[], nearestMeasured: (placeId: number) => number | null) {
  const byGroup = new Map<string, number>();
  const byMeasured = new Map<number, Map<string, number>>();
  let unmeasured = 0;
  for (const u of units) {
    if (!(u.units > 0)) continue;
    addTo(byGroup, u.group, u.units);
    const m = nearestMeasured(u.placeId);
    if (m == null) {
      unmeasured = roundQty(unmeasured + u.units);
      continue;
    }
    const inner = byMeasured.get(m) ?? new Map<string, number>();
    addTo(inner, u.group, u.units);
    byMeasured.set(m, inner);
  }
  return { byGroup, byMeasured, unmeasured };
}

/** Each measured place's footage, shared by unit over the groups counting toward it. */
function shareSpace(
  measuredPlaces: { id: number; footage: number }[],
  byMeasured: Map<number, Map<string, number>>,
) {
  const byGroup = new Map<string, number>();
  let empty = 0;
  for (const p of measuredPlaces) {
    const inner = byMeasured.get(p.id);
    const total = inner ? sumOf(inner) : 0;
    if (!inner || total <= 0) {
      empty += p.footage;
      continue;
    }
    for (const [group, n] of inner) {
      byGroup.set(group, (byGroup.get(group) ?? 0) + (p.footage * n) / total);
    }
  }
  return { byGroup, empty };
}

/**
 * Pure: units and square feet per group. `places` is the tree (with square
 * footage) the units sit in; `units` are the units at each place, already
 * labelled with their group. Group rows come largest space first, then
 * "Empty space" and "Unmeasured units" last when there are any.
 */
export function splitSpaceBy(
  places: MeasuredPlace[],
  units: UnitAtPlace[],
): { rows: SpaceRow[]; doubleCounts: DoubleCount[] } {
  const footage = new Map(places.map((p) => [p.id, p.squareFootage ?? 0]));
  const measured = (id: number) => (footage.get(id) ?? 0) > 0;

  // The nearest measured place: the place itself, or the closest one above it.
  const nearest = new Map<number, number | null>();
  const nearestMeasured = (id: number): number | null => {
    if (!nearest.has(id)) {
      const upward = ancestry(places, id).reverse();
      nearest.set(id, upward.find((p) => measured(p.id))?.id ?? null);
    }
    return nearest.get(id) ?? null;
  };

  const tally = tallyUnits(units, nearestMeasured);
  const measuredPlaces = places
    .filter((p) => measured(p.id))
    .map((p) => ({ id: p.id, footage: footage.get(p.id)! }));
  const space = shareSpace(measuredPlaces, tally.byMeasured);

  const rows: SpaceRow[] = [...tally.byGroup.entries()].map(([group, n]) => ({
    group,
    units: n,
    squareFeet: Math.round((space.byGroup.get(group) ?? 0) * 10) / 10,
  }));
  rows.sort(
    (a, b) => b.squareFeet - a.squareFeet || b.units - a.units || a.group.localeCompare(b.group),
  );
  if (space.empty > 0) rows.push({ group: EMPTY_SPACE, units: 0, squareFeet: space.empty });
  if (tally.unmeasured > 0) {
    rows.push({ group: UNMEASURED, units: tally.unmeasured, squareFeet: 0 });
  }

  const doubleCounts: DoubleCount[] = [];
  for (const p of measuredPlaces) {
    const parent = places.find((q) => q.id === p.id)?.parentId;
    const above = parent == null ? null : nearestMeasured(parent);
    if (above != null) doubleCounts.push({ placeId: p.id, insideId: above });
  }
  return { rows, doubleCounts };
}

export interface StockByScope {
  /** Look inside this store (all its places) ... */
  storeLocationId?: number | null;
  /** ... or inside this place (it and everything inside it). Neither = every store. */
  stockLocationId?: number | null;
}

export interface StockByResult {
  field: StockByField;
  rows: SpaceRow[];
  warnings: string[];
}

export class StockByScopeError extends Error {}

/** The report from the database: owned stock in scope, grouped by `field`. */
export async function getStockBy(
  db: Db,
  scope: StockByScope,
  field: StockByField,
): Promise<StockByResult> {
  const rootId = scope.stockLocationId ?? null;
  let storeId = scope.storeLocationId ?? null;
  if (rootId != null) {
    const root = await db.stockLocation.findUnique({
      where: { id: rootId },
      select: { storeLocationId: true },
    });
    if (!root) throw new StockByScopeError("That place does not exist.");
    if (storeId != null && storeId !== root.storeLocationId) {
      throw new StockByScopeError("That place is at a different store.");
    }
    storeId = root.storeLocationId;
  }

  const allPlaces = await db.stockLocation.findMany({
    where: storeId != null ? { storeLocationId: storeId } : undefined,
    select: {
      id: true,
      parentId: true,
      name: true,
      locationType: true,
      squareFootage: true,
      storeLocation: { select: { name: true } },
    },
  });
  const placeIds = rootId != null ? new Set([rootId, ...descendantIds(allPlaces, rootId)]) : null;
  const places = placeIds ? allPlaces.filter((p) => placeIds.has(p.id)) : allPlaces;

  const positions = await db.inventoryPosition.findMany({
    where: {
      ...(storeId != null ? { storeLocationId: storeId } : {}),
      ...(placeIds ? { stockLocationId: { in: [...placeIds] } } : {}),
    },
    select: {
      stockLocationId: true,
      quantity: true,
      product: {
        select: {
          department: { select: { name: true } },
          category: { select: { name: true } },
          type: { select: { name: true } },
          vendor: { select: { name: true } },
          collection: { select: { name: true } },
        },
      },
    },
  });

  const byId = new Map(allPlaces.map((p) => [p.id, p]));
  // "Places inside it": every store, when looking at everything; a store's top
  // places, when looking inside a store; the places directly inside a place.
  const placeInside = (placeId: number): string => {
    const place = byId.get(placeId);
    if (!place) return "—";
    if (storeId == null) return place.storeLocation.name;
    const chain = ancestry(allPlaces, placeId);
    const below = rootId == null ? chain[0] : chain[chain.findIndex((p) => p.id === rootId) + 1];
    return below ? below.name : `${place.name} itself`;
  };

  const groupOf = (p: (typeof positions)[number]): string => {
    switch (field) {
      case "place":
        return placeInside(p.stockLocationId);
      case "placeType": {
        const t = byId.get(p.stockLocationId)?.locationType;
        return isStockLocationType(t) ? LOCATION_TYPE_INFO[t].label : (t ?? "—");
      }
      case "department":
        return p.product.department.name;
      case "category":
        return p.product.category.name;
      case "type":
        return p.product.type?.name ?? "No type";
      case "vendor":
        return p.product.vendor.name;
      case "collection":
        return p.product.collection?.name ?? "No collection";
    }
  };

  const { rows, doubleCounts } = splitSpaceBy(
    places,
    positions.map((p) => ({
      placeId: p.stockLocationId,
      group: groupOf(p),
      units: toQty(p.quantity),
    })),
  );
  const name = (id: number) => byId.get(id)?.name ?? `#${id}`;
  const warnings = doubleCounts.map(
    (d) =>
      `"${name(d.placeId)}" has square footage and is inside "${name(d.insideId)}", which has its own: ` +
      `that floor is counted twice. Measure the places inside, or the place around them, not both.`,
  );
  return { field, rows, warnings };
}
