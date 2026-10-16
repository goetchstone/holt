// /app/src/lib/inventory/places.ts
//
// Every unit of stock is somewhere, and each store says where stock lands when
// a flow does not name a place: its LANDING PLACES, set in Warehouse >
// Locations.
//
//   RECEIVING   goods from a supplier, or a unit recorded with only a store
//   RETURNS     a customer's return, until it is put back or written off
//   QUARANTINE  damaged or wrong goods off a delivery
//   TRANSIT     units shipped from this store and not yet received elsewhere
//   PICKUP      units waiting for a customer to collect
//
// The first four are created the first time a store that has none needs one --
// a place with the code below, of the type below, recorded on the store so the
// next write finds it. That is a product default, not a guess about a
// deployment: every store that takes delivery has somewhere goods land, and
// receiving a customer's return must never wait on someone setting up a place.
// An admin can point any of them at a different place at any time.
//
// PICKUP has no default. A store without one has nowhere pickups wait, and the
// pull list says so rather than inventing a place (rule 63).

import type { Prisma } from "@prisma/client";
import { withStockTx, type Place, type PrismaTx } from "./ledger";
import {
  LANDING_PLACES,
  landingAllows,
  landingTypesText,
  type LandingPlace,
  type LandingPlaceInfo,
  type StorePointer,
} from "./landingPlaces";

export { LANDING_PLACES, type LandingPlace } from "./landingPlaces";

/** The code a receiving place Holt creates for a store has. */
export const RECEIVING_PLACE_CODE = LANDING_PLACES.RECEIVING.create.code;

/**
 * Advisory-lock space for creating a store's landing places, separate from the
 * stock lock space in ledger.ts, so two sessions that both find a store with no
 * such place create one place between them, not two.
 */
const PLACE_SETUP_LOCK_SPACE = 5_461_068;

/** A store has no place set for a landing place that is never created for it. */
export class LandingPlaceUnsetError extends Error {
  constructor(
    readonly storeLocationId: number,
    readonly kind: LandingPlace,
  ) {
    super(
      `Set a ${LANDING_PLACES[kind].setting.toLowerCase()} for this store (Warehouse > Locations).`,
    );
    this.name = "LandingPlaceUnsetError";
  }
}

/**
 * The store's landing place of this kind: the one its setting names, or -- for
 * every kind but PICKUP -- a place created and recorded the first time it is
 * needed. Throws LandingPlaceUnsetError for an unset PICKUP.
 */
export async function landingPlaceId(
  db: PrismaTx,
  storeLocationId: number,
  kind: LandingPlace,
): Promise<number> {
  const info: LandingPlaceInfo = LANDING_PLACES[kind];
  return withStockTx(db, async (tx) => {
    const current = await readPointer(tx, storeLocationId, info.pointer);
    if (current != null) return current;
    if (!info.create) throw new LandingPlaceUnsetError(storeLocationId, kind);

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACE_SETUP_LOCK_SPACE}::int, ${storeLocationId}::int)`;
    const afterLock = await readPointer(tx, storeLocationId, info.pointer);
    if (afterLock != null) return afterLock;

    // A store may already have a place with this code that nobody pointed the
    // setting at; that is the place, not a second one beside it. The compound
    // key has no nullable column, so this upsert can match (rule 64).
    const place = await tx.stockLocation.upsert({
      where: { storeLocationId_code: { storeLocationId, code: info.create.code } },
      create: {
        storeLocationId,
        code: info.create.code,
        name: info.create.name,
        locationType: info.create.type,
        createdBy: "system",
      },
      update: {},
      select: { id: true },
    });
    await tx.storeLocation.update({
      where: { id: storeLocationId },
      data: { [info.pointer]: place.id },
    });
    return place.id;
  });
}

/** The store's pickup place, or null when it has none set. */
export async function pickupPlaceId(db: PrismaTx, storeLocationId: number): Promise<number | null> {
  return readPointer(db, storeLocationId, LANDING_PLACES.PICKUP.pointer);
}

async function readPointer(
  db: PrismaTx | Prisma.TransactionClient,
  storeLocationId: number,
  pointer: StorePointer,
): Promise<number | null> {
  const store = await db.storeLocation.findUnique({
    where: { id: storeLocationId },
    select: { [pointer]: true } as Record<StorePointer, true>,
  });
  if (!store) throw new Error(`Store ${storeLocationId} does not exist.`);
  return (store as Record<StorePointer, number | null>)[pointer] ?? null;
}

/** The store's receiving place, created and recorded the first time it is needed. */
export function receivingStockLocationId(db: PrismaTx, storeLocationId: number): Promise<number> {
  return landingPlaceId(db, storeLocationId, "RECEIVING");
}

/**
 * A place at `storeLocationId`: the stock location given, or the store's
 * receiving place when none is. For callers whose input lets the place be left
 * out.
 */
export async function placeAt(
  db: PrismaTx,
  args: {
    storeLocationId: number;
    stockLocationId?: number | null;
    salesOrderId?: number | null;
  },
): Promise<Place> {
  return {
    storeLocationId: args.storeLocationId,
    stockLocationId:
      args.stockLocationId ?? (await receivingStockLocationId(db, args.storeLocationId)),
    salesOrderId: args.salesOrderId ?? null,
  };
}

/** The settings a store's edit may change, by landing-place kind. */
export type LandingPlacePatch = Partial<Record<LandingPlace, number | null>>;

/**
 * Check a store edit's landing places before it is saved: each must be a place
 * at this store, of a type the setting allows. Returns the first problem as a
 * message for a 400, or null when the edit is fine.
 */
export async function landingPlaceProblem(
  db: PrismaTx,
  storeLocationId: number,
  patch: LandingPlacePatch,
): Promise<string | null> {
  const ids = Object.values(patch).filter((id): id is number => typeof id === "number");
  if (ids.length === 0) return null;
  const places = await db.stockLocation.findMany({
    where: { id: { in: ids } },
    select: { id: true, storeLocationId: true, locationType: true, name: true },
  });
  const byId = new Map(places.map((p) => [p.id, p]));
  for (const [kind, id] of Object.entries(patch) as [LandingPlace, number | null][]) {
    if (id == null) continue;
    const info: LandingPlaceInfo = LANDING_PLACES[kind];
    const place = byId.get(id);
    if (!place) return `${info.setting}: stock location ${id} does not exist.`;
    if (place.storeLocationId !== storeLocationId) {
      return `${info.setting}: "${place.name}" is at a different store.`;
    }
    if (!landingAllows(info, place.locationType)) {
      return `${info.setting}: "${place.name}" is a ${place.locationType} place; it must be ${landingTypesText(info)}.`;
    }
  }
  return null;
}
