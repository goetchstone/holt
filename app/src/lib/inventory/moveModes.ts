// /app/src/lib/inventory/moveModes.ts
//
// How stock may move between two places. One catalog (rule 37), one decision.
//
//   QUICK    A to B now, one movement: "we forgot this, it is here, move it".
//   TRACKED  a transfer document: A to the source store's transit place, then
//            received at B (in parts if need be), so stock on its way is
//            visible and owned the whole time.
//
// A place may set a mode; a place without one takes its store's; a store
// without one takes the default -- QUICK within a store, TRACKED between
// stores. A move uses the stricter of its two ends. The mode is a minimum:
// anyone may always take the longer way and raise a transfer for a move that
// could have been quick.
//
// SCANNED (tracked, with a scan at load and unload) arrives with the handheld
// pages that can satisfy it (ledger plan PR 4).

import type { PrismaTx } from "./ledger";

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

/** The mode a move from one stock location to another needs, read from the database. */
export async function requiredMoveMode(
  db: PrismaTx,
  fromStockLocationId: number,
  toStockLocationId: number,
): Promise<MoveMode> {
  const places = await db.stockLocation.findMany({
    where: { id: { in: [fromStockLocationId, toStockLocationId] } },
    select: {
      id: true,
      storeLocationId: true,
      moveMode: true,
      storeLocation: { select: { moveMode: true } },
    },
  });
  const from = places.find((p) => p.id === fromStockLocationId);
  const to = places.find((p) => p.id === toStockLocationId);
  if (!from || !to) throw new Error("Both ends of a move must be stock locations that exist.");
  return moveModeFor({
    sameStore: from.storeLocationId === to.storeLocationId,
    from: endMode({ placeMode: from.moveMode, storeMode: from.storeLocation.moveMode }),
    to: endMode({ placeMode: to.moveMode, storeMode: to.storeLocation.moveMode }),
  });
}
