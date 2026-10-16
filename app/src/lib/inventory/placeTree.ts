// /app/src/lib/inventory/placeTree.ts
//
// Places contain places (ledger plan phase 12). A store's stock locations form
// a tree through StockLocation.parentId: North Barn > Floor 2 > Stock Sofas >
// Shelf 3 are all places, as deep as a store wants, and a small store stays
// flat. A GROUP place (a building, a floor) holds only places, never stock.
//
// One rule, one home, so every writer of a place -- the locations routes, the
// stock-location preset -- checks it the same way (rule 42):
//
//   - a parent is an active place in the same store;
//   - a place is never inside itself, however deep the loop would be;
//   - a place still holding stock, or where a store lands stock, never
//     becomes a GROUP.
//
// Totals for a building, a floor or a store are the sum of everything inside
// it: descendantIds() is the walk every report uses.

import type { Prisma, PrismaClient } from "@prisma/client";
import { LOCATION_TYPE_INFO, isStockLocationType } from "@/lib/inventory/locationTypes";
import { LANDING_PLACES } from "@/lib/inventory/landingPlaces";

type Db = PrismaClient | Prisma.TransactionClient;

export interface PlaceNode {
  id: number;
  parentId: number | null;
}

/** Pure: every place inside `rootId` (not including it), however deep. */
export function descendantIds(places: PlaceNode[], rootId: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of places) {
    if (p.parentId == null) continue;
    const list = children.get(p.parentId) ?? [];
    list.push(p.id);
    children.set(p.parentId, list);
  }
  const out: number[] = [];
  const queue = [...(children.get(rootId) ?? [])];
  const seen = new Set<number>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue; // a loop in stored data never hangs a report
    seen.add(id);
    out.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}

/** Pure: the chain of places from the top of the tree down to `id`. */
export function ancestry<T extends PlaceNode>(places: T[], id: number): T[] {
  const byId = new Map(places.map((p) => [p.id, p]));
  const chain: T[] = [];
  const seen = new Set<number>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId == null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

/** Pure: "North Barn › Floor 2 › Stock Sofas" for a place. */
export function placePath<T extends PlaceNode & { name: string }>(places: T[], id: number): string {
  return ancestry(places, id)
    .map((p) => p.name)
    .join(" › ");
}

/**
 * Why `parentId` cannot be `placeId`'s parent in `storeLocationId`, or null
 * when it can. `placeId` is null for a place not yet created.
 */
export async function placeParentProblem(
  db: Db,
  args: { placeId: number | null; storeLocationId: number; parentId: number | null },
): Promise<string | null> {
  if (args.parentId == null) return null;
  if (args.parentId === args.placeId) return "A place cannot be inside itself.";
  const places = await db.stockLocation.findMany({
    where: { storeLocationId: args.storeLocationId },
    select: { id: true, parentId: true, isActive: true },
  });
  const parent = places.find((p) => p.id === args.parentId);
  if (!parent) return "The place it is inside must be a stock location at the same store.";
  if (!parent.isActive)
    return "The place it is inside is inactive; reactivate it or choose another.";
  if (args.placeId != null && descendantIds(places, args.placeId).includes(args.parentId)) {
    return "A place cannot be inside a place that is inside it.";
  }
  return null;
}

/**
 * Why `placeId` cannot be deactivated, or null when it can: places still
 * active inside it would be left inside a place nobody can pick.
 */
export async function placeDeactivateProblem(db: Db, placeId: number): Promise<string | null> {
  const inside = await db.stockLocation.count({ where: { parentId: placeId, isActive: true } });
  return inside > 0
    ? `${inside} active place(s) are inside this one; move or deactivate them first.`
    : null;
}

/**
 * Why `placeId` cannot be of `locationType`, or null when it can. A GROUP
 * holds only places, so a place still holding stock cannot become one until
 * the stock is moved out; the ledger refuses new stock into a group, and this
 * keeps stock already there from being stranded in one. Nor can a store's
 * landing place (its receiving, returns, ... place), where stock is about to
 * land.
 */
export async function placeTypeProblem(
  db: Db,
  args: { placeId: number; locationType: string },
): Promise<string | null> {
  if (isStockLocationType(args.locationType) && LOCATION_TYPE_INFO[args.locationType].holdsStock) {
    return null;
  }
  const held = await db.inventoryPosition.count({ where: { stockLocationId: args.placeId } });
  if (held > 0) return "This place holds stock; move it out before making the place a group.";
  const landing = await db.storeLocation.findFirst({
    where: { OR: Object.values(LANDING_PLACES).map((l) => ({ [l.pointer]: args.placeId })) },
    select: { name: true },
  });
  return landing
    ? `This place is where ${landing.name} lands stock (Warehouse › Locations); choose another place there first.`
    : null;
}

/**
 * Pure: places in tree order -- each place followed by the places inside it,
 * siblings by sortOrder then code -- with how deep each sits. For screens that
 * show a store's places as a tree.
 */
export function treeOrder<T extends PlaceNode & { sortOrder: number; code: string }>(
  places: T[],
): { place: T; depth: number }[] {
  const ids = new Set(places.map((p) => p.id));
  const children = new Map<number | null, T[]>();
  for (const p of places) {
    // A place whose parent is not in the list (inactive, filtered) shows at the top.
    const key = p.parentId != null && ids.has(p.parentId) ? p.parentId : null;
    const list = children.get(key) ?? [];
    list.push(p);
    children.set(key, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }
  const out: { place: T; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const p of children.get(parent) ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ place: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
