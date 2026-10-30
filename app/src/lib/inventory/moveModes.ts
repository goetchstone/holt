// /app/src/lib/inventory/moveModes.ts
//
// How stock may move between two places. One catalog (rule 37), one decision.
//
//   QUICK    A to B now, one movement: "we forgot this, it is here, move it".
//   TRACKED  a transfer document: A to the source store's transit place, then
//            received at B (in parts if need be), so stock on its way is
//            visible and owned the whole time.
//
// A place may set a mode; a place without one takes the nearest place above
// it that has one (requiredMoveMode), then its store's; a store without one
// takes the default -- QUICK within a store, TRACKED between stores. A move
// uses the stricter of its two ends. The mode is a minimum: anyone may always
// take the longer way and raise a transfer for a move that could have been
// quick.
//
// SCANNED (tracked, with a scan at load and unload) is not built: the
// handheld move is quick only. Tracked in ROADMAP.md, "Handheld floor".

import { ancestry } from "./placeTree";
import { PlaceError, type PrismaTx } from "./ledger";

export const MOVE_MODES = ["QUICK", "TRACKED"] as const;
export type MoveMode = (typeof MOVE_MODES)[number];

const STRICTNESS: Record<MoveMode, number> = { QUICK: 0, TRACKED: 1 };

export function isMoveMode(value: unknown): value is MoveMode {
  return typeof value === "string" && (MOVE_MODES as readonly string[]).includes(value);
}

/** The stricter of two modes. */
export function stricter(a: MoveMode, b: MoveMode): MoveMode {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * Pure: the mode one end of a move asks for -- its place's setting, else its
 * store's, else null (no preference).
 */
export function endMode(end: {
  placeMode?: string | null;
  storeMode?: string | null;
}): MoveMode | null {
  if (isMoveMode(end.placeMode)) return end.placeMode;
  if (isMoveMode(end.storeMode)) return end.storeMode;
  return null;
}

/** Pure: the mode a move between two ends needs. */
export function moveModeFor(args: {
  sameStore: boolean;
  from: MoveMode | null;
  to: MoveMode | null;
}): MoveMode {
  const fallback: MoveMode = args.sameStore ? "QUICK" : "TRACKED";
  return stricter(args.from ?? fallback, args.to ?? fallback);
}

/**
 * The mode a move from one stock location to another needs, read from the
 * database. A place without a mode of its own takes the nearest one above it
 * in its store's tree (lib/inventory/placeTree.ts) -- set TRACKED on a
 * building and every bay in it is tracked -- then its store's.
 */
export async function requiredMoveMode(
  db: PrismaTx,
  fromStockLocationId: number,
  toStockLocationId: number,
): Promise<MoveMode> {
  const ends = await db.stockLocation.findMany({
    where: { id: { in: [fromStockLocationId, toStockLocationId] } },
    select: { id: true, storeLocationId: true, storeLocation: { select: { moveMode: true } } },
  });
  const from = ends.find((p) => p.id === fromStockLocationId);
  const to = ends.find((p) => p.id === toStockLocationId);
  if (!from || !to) {
    throw new PlaceError("Both ends of a move must be stock locations that exist.");
  }
  const tree = await db.stockLocation.findMany({
    where: { storeLocationId: { in: [from.storeLocationId, to.storeLocationId] } },
    select: { id: true, parentId: true, moveMode: true },
  });
  const placeMode = (id: number) =>
    ancestry(tree, id)
      .reverse()
      .find((p) => isMoveMode(p.moveMode))?.moveMode ?? null;
  return moveModeFor({
    sameStore: from.storeLocationId === to.storeLocationId,
    from: endMode({ placeMode: placeMode(from.id), storeMode: from.storeLocation.moveMode }),
    to: endMode({ placeMode: placeMode(to.id), storeMode: to.storeLocation.moveMode }),
  });
}
