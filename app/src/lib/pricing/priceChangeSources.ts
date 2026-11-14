// /app/src/lib/pricing/priceChangeSources.ts
//
// What changed a product's retail, as its price ledger records it
// (ProductPriceChange.source, GAP-06). The one list (rule 37): the writer
// accepts only these, and the product screen's price history labels them.
// Pure, so the screen and the server share it.

export const PRICE_CHANGE_SOURCES = {
  MANUAL: "Edited by hand",
  MASS_CHANGE: "Mass price change",
  IMPORT: "Product import",
  LEGACY_FEED: "Point-of-sale feed",
  CONSIGNMENT_IMPORT: "Consignment import",
  STYLE_EDIT: "Vendor style edit",
} as const;

export type PriceChangeSource = keyof typeof PRICE_CHANGE_SOURCES;

export function isPriceChangeSource(value: unknown): value is PriceChangeSource {
  return typeof value === "string" && Object.hasOwn(PRICE_CHANGE_SOURCES, value);
}
