// /app/src/lib/inventory/snapshotImport.ts
//
// Per-row resolution for the POS snapshot cutover importer
// (pages/api/import/inventory-snapshot.ts). Pure -- no I/O -- so the
// skip/invalid/unresolved-product/unresolved-location/ok decision tree is
// unit-tested without touching Prisma (rule 14: branching logic belongs in
// pure helpers in lib/; handlers shrink to auth, Prisma, and error
// handling). The handler just preloads the two maps and switches on the
// result.

export interface SnapshotImportMaps {
  /** Product.externalId -> Product.id, for products that have one. */
  productByExternalId: Map<number, number>;
  /** Lowercased, trimmed StockLocation.locationAliases entry -> its ids. */
  locationAliasMap: Map<string, { stockLocationId: number; storeLocationId: number }>;
}

export interface ResolvedSnapshotImportRow {
  productId: number;
  storeLocationId: number;
  stockLocationId: number;
  quantity: number;
  externalId: number;
  externalStockLocation: string;
}

export type SnapshotImportRowResult =
  // No Stockid at all -- CSVs commonly have trailing blank rows. Same
  // tolerance the original importer had.
  | { status: "skip" }
  | { status: "invalid"; message: string }
  | { status: "unresolvedProduct"; externalId: number; location: string }
  | { status: "unresolvedLocation"; externalId: number; location: string }
  | { status: "ok"; row: ResolvedSnapshotImportRow };

/**
 * Resolve one raw POS snapshot CSV row to holt's own identity, or classify
 * why it can't be resolved. Product is checked before location, so a row
 * that fails both is reported once, as unresolvedProduct -- see this
 * module's caller for why that's an intentional priority, not an oversight.
 */
export function resolveSnapshotImportRow(
  record: Record<string, unknown>,
  maps: SnapshotImportMaps,
): SnapshotImportRowResult {
  const stockIdStr = record.Stockid || record.stockid;
  if (
    !stockIdStr ||
    String(stockIdStr).trim() === "" ||
    Number.isNaN(Number.parseInt(String(stockIdStr)))
  ) {
    return { status: "skip" };
  }

  const stockLevelStr =
    record.Stocklevel || record.stocklevel || record["On Hand"] || record["on hand"];
  const externalId = Number.parseInt(String(stockIdStr).trim(), 10);
  const quantity = Number.parseFloat(String(stockLevelStr).trim());
  const location = String(record.Stocklocation || record.stocklocation || "").trim();

  if (Number.isNaN(externalId) || Number.isNaN(quantity)) {
    return { status: "invalid", message: "Invalid number format for Stockid or Stocklevel." };
  }

  const productId = maps.productByExternalId.get(externalId);
  if (!productId) {
    return { status: "unresolvedProduct", externalId, location };
  }

  const locationMatch = location ? maps.locationAliasMap.get(location.toLowerCase()) : undefined;
  if (!locationMatch) {
    return { status: "unresolvedLocation", externalId, location };
  }

  return {
    status: "ok",
    row: {
      productId,
      storeLocationId: locationMatch.storeLocationId,
      stockLocationId: locationMatch.stockLocationId,
      quantity,
      externalId,
      externalStockLocation: location,
    },
  };
}
