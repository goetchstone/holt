// /app/src/lib/inventory/locationTypes.ts
//
// The kinds of place stock can sit in, and which of them hold stock that can be
// sold. One catalog (CLAUDE.md rule 37): the free-stock predicate, the raw-SQL
// reports, the locations screen and the stock-location preset all read it, so
// "is stock here sellable" has one answer.
//
// StockLocation.locationType stays a string column; the routes and the preset
// that write it choose from this list and refuse anything else. A new type is a
// code change here, never a value somebody types.
//
// Owned is not the same as sellable. Stock in quarantine (damaged, an
// incomplete set of boxes, a return waiting for inspection) or in transit
// between sites is Holt's and is counted and valued, but nobody can sell it
// until it is somewhere sellable.
//
// WORK_CENTRE is reserved for manufacturing and GROUP (a place that holds only
// other places) arrives with nested places; neither is listed until something
// uses it.

export const STOCK_LOCATION_TYPES = [
  "FLOOR",
  "STOCK",
  "RECEIVING",
  "STAGING",
  "QUARANTINE",
  "TRANSIT",
] as const;

export type StockLocationType = (typeof STOCK_LOCATION_TYPES)[number];

interface LocationTypeInfo {
  label: string;
  /** Free stock here can be sold and allocated. */
  sellable: boolean;
}

export const LOCATION_TYPE_INFO: Record<StockLocationType, LocationTypeInfo> = {
  FLOOR: { label: "Sales floor", sellable: true },
  STOCK: { label: "Stock room", sellable: true },
  // Arrived and not yet put away. Still sellable: a customer can buy the sofa
  // that came off the truck this morning.
  RECEIVING: { label: "Receiving", sellable: true },
  // Picked and waiting to load. Not offered for sale, so a unit pulled for one
  // delivery is not sold again from the dock.
  STAGING: { label: "Staging", sellable: false },
  QUARANTINE: { label: "Quarantine", sellable: false },
  TRANSIT: { label: "In transit", sellable: false },
};

export const SELLABLE_LOCATION_TYPES: StockLocationType[] = STOCK_LOCATION_TYPES.filter(
  (t) => LOCATION_TYPE_INFO[t].sellable,
);

export function isStockLocationType(value: unknown): value is StockLocationType {
  return typeof value === "string" && (STOCK_LOCATION_TYPES as readonly string[]).includes(value);
}

/**
 * The sellable test for raw SQL, against a joined StockLocation alias. The keys
 * are this file's constants, never input, so they are written into the
 * statement directly.
 */
export function sellableTypesSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Bad SQL alias: ${alias}`);
  return `${alias}."locationType" IN (${SELLABLE_LOCATION_TYPES.map((t) => `'${t}'`).join(", ")})`;
}
