// /app/src/lib/inventory/landingPlaces.ts
//
// The catalog of a store's landing places -- where stock lands when a flow
// names no place (lib/inventory/places.ts says what each is for). Kept apart
// from places.ts, which reads the database, so the Warehouse > Locations
// screen can list the same settings without bundling the database client.

import { isStockLocationType, LOCATION_TYPE_INFO, type StockLocationType } from "./locationTypes";

export type StorePointer =
  | "defaultReceivingStockLocationId"
  | "returnsStockLocationId"
  | "quarantineStockLocationId"
  | "transitStockLocationId"
  | "pickupStockLocationId";

export interface LandingPlaceInfo {
  /** The StoreLocation column that records it. */
  pointer: StorePointer;
  /** What the setting is called on screen, for errors that name it. */
  setting: string;
  /** Created when missing, with this code, name and type; null = never created. */
  create: { code: string; name: string; type: StockLocationType } | null;
  /** Types the setting may point at; "any" = any type that holds stock. */
  allowedTypes: readonly StockLocationType[] | "any";
}

export const LANDING_PLACES = {
  RECEIVING: {
    pointer: "defaultReceivingStockLocationId",
    setting: "Receiving place",
    create: { code: "RECEIVING", name: "Receiving", type: "RECEIVING" },
    allowedTypes: ["RECEIVING", "STOCK", "FLOOR", "QUARANTINE"],
  },
  // Not for sale until someone puts each piece back (the store's returned-stock
  // queue). A store that wants returns sellable at once points this at a
  // sellable place; the place's type is the whole setting.
  RETURNS: {
    pointer: "returnsStockLocationId",
    setting: "Returns place",
    create: { code: "RETURNS", name: "Returns", type: "QUARANTINE" },
    allowedTypes: "any",
  },
  QUARANTINE: {
    pointer: "quarantineStockLocationId",
    setting: "Quarantine place",
    create: { code: "QUARANTINE", name: "Quarantine", type: "QUARANTINE" },
    allowedTypes: ["QUARANTINE"],
  },
  TRANSIT: {
    pointer: "transitStockLocationId",
    setting: "In-transit place",
    create: { code: "TRANSIT", name: "In transit", type: "TRANSIT" },
    allowedTypes: ["TRANSIT"],
  },
  PICKUP: {
    pointer: "pickupStockLocationId",
    setting: "Pickup place",
    create: null,
    allowedTypes: ["STAGING", "STOCK", "FLOOR", "RECEIVING"],
  },
} as const satisfies Record<string, LandingPlaceInfo>;

export type LandingPlace = keyof typeof LANDING_PLACES;

/**
 * Whether a landing place may point at a place of `locationType`. Stock lands
 * there, so never a GROUP, whatever the setting allows. One check for the
 * store route and the screen's pickers.
 */
export function landingAllows(info: LandingPlaceInfo, locationType: string): boolean {
  if (!isStockLocationType(locationType) || !LOCATION_TYPE_INFO[locationType].holdsStock) {
    return false;
  }
  return info.allowedTypes === "any" || info.allowedTypes.includes(locationType);
}

/** The types `info` allows, for an error that lists them. */
export function landingTypesText(info: LandingPlaceInfo): string {
  return info.allowedTypes === "any" ? "a place that holds stock" : info.allowedTypes.join(" or ");
}
