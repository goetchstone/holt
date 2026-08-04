// /app/__tests__/snapshotImport.test.ts
//
// Pure unit tests for resolveSnapshotImportRow -- the per-row decision logic
// behind the POS snapshot cutover importer
// (pages/api/import/inventory-snapshot.ts). No database: the maps it
// resolves against are plain JS Maps built from fixture data here, so every
// branch (skip / invalid / unresolved product / unresolved location / ok) is
// pinned without touching Prisma.

import { resolveSnapshotImportRow, type SnapshotImportMaps } from "@/lib/inventory/snapshotImport";

function maps(): SnapshotImportMaps {
  return {
    productByExternalId: new Map([[555, 42]]),
    locationAliasMap: new Map([
      ["warehouse", { stockLocationId: 7, storeLocationId: 3 }],
      ["main showroom", { stockLocationId: 8, storeLocationId: 4 }],
    ]),
  };
}

describe("resolveSnapshotImportRow", () => {
  it("skips a row with no Stockid (trailing blank CSV rows)", () => {
    const result = resolveSnapshotImportRow({ Stocklevel: "5" }, maps());
    expect(result.status).toBe("skip");
  });

  it("skips a row whose Stockid isn't a number", () => {
    const result = resolveSnapshotImportRow({ Stockid: "not-a-number" }, maps());
    expect(result.status).toBe("skip");
  });

  it("reports invalid when Stocklevel isn't a number", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "555", Stocklevel: "not-a-number", Stocklocation: "Warehouse" },
      maps(),
    );
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("reports unresolvedProduct when externalId matches no Product", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "999", Stocklevel: "5", Stocklocation: "Warehouse" },
      maps(),
    );
    expect(result).toMatchObject({ status: "unresolvedProduct", externalId: 999, location: "Warehouse" });
  });

  it("reports unresolvedLocation when the location matches no alias", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "555", Stocklevel: "5", Stocklocation: "Nowhere" },
      maps(),
    );
    expect(result).toMatchObject({
      status: "unresolvedLocation",
      externalId: 555,
      location: "Nowhere",
    });
  });

  it("reports unresolvedLocation (not unresolvedProduct) when the location is blank", () => {
    const result = resolveSnapshotImportRow({ Stockid: "555", Stocklevel: "5" }, maps());
    expect(result).toMatchObject({ status: "unresolvedLocation", location: "" });
  });

  it("prioritizes unresolvedProduct over unresolvedLocation when a row fails both", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "999", Stocklevel: "5", Stocklocation: "Nowhere" },
      maps(),
    );
    expect(result.status).toBe("unresolvedProduct");
  });

  it("matches locationAliases case-insensitively and trimmed", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "555", Stocklevel: "5", Stocklocation: "  WAREHOUSE  " },
      maps(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.row.storeLocationId).toBe(3);
      expect(result.row.stockLocationId).toBe(7);
    }
  });

  it("resolves a fully-matched row with IMPORT provenance fields", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "555", Stocklevel: "12.5", Stocklocation: "Main Showroom" },
      maps(),
    );
    expect(result).toMatchObject({
      status: "ok",
      row: {
        productId: 42,
        storeLocationId: 4,
        stockLocationId: 8,
        quantity: 12.5,
        externalId: 555,
        externalStockLocation: "Main Showroom",
      },
    });
  });

  it("accepts the lowercase field-name variants (stockid/stocklevel/stocklocation)", () => {
    const result = resolveSnapshotImportRow(
      { stockid: "555", stocklevel: "3", stocklocation: "Warehouse" },
      maps(),
    );
    expect(result.status).toBe("ok");
  });

  it("accepts the 'On Hand' header variant for quantity", () => {
    const result = resolveSnapshotImportRow(
      { Stockid: "555", "On Hand": "8", Stocklocation: "Warehouse" },
      maps(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.row.quantity).toBe(8);
  });
});
