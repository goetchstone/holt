// /app/src/lib/buyerDraftExport.ts
//
// Pure helpers that turn `BuyerDraftItem` + `BuyerDraftPurchaseOrder` rows
// into CSVs that match the POS's import formats.
//
// Two outputs:
//
//   1. Items CSV — the vendor-product import, columns:
//        Category, Cost Price, Department, Description, Part Number,
//        Product Name, Product Height, Product Length, Product Width,
//        Selling Price, RRP, Stock Family, Supplier
//      For apparel drafts an optional Barcode column appears at the end.
//
//   2. POs CSV — the purchase-order import, columns:
//        Supplier, Qty, Part Number, Location Code, Cost Price,
//        Description, Reference Number
//
// These are pure (no I/O, no Prisma); the API endpoints fetch the rows
// then call into here. That keeps the CSV format unit-testable without
// spinning up a DB. Column lists come straight from the user's spec
// (2026-05-08): see CLAUDE.md "Buyer drafts" section + the comment at
// the top of `prisma/schema.prisma:BuyerDraftItem`.
//
// Why two separate exports rather than one: the POS imports them in two
// distinct steps — items first (to register part numbers + create master
// catalog rows), then POs (which reference those part numbers). The buyer
// doesn't need both in the same file, and keeping them separate matches
// the POS's import wizard exactly.

import { csvRow } from "./csvExport";

// ─── Input shapes ──────────────────────────────────────────────────────
//
// We accept POJOs (not Prisma models directly) so the API endpoint can
// massage Decimal → number before calling. This also means the unit tests
// don't need Prisma's runtime to construct fixtures.

export type DraftItemForExport = {
  partNumber: string;
  productName: string;
  description: string | null;
  cost: number;
  retail: number; // "Selling Price / as shown"
  msrp: number | null; // RRP / "was" price

  // Dimensions (inches)
  productWidth: number | null;
  productLength: number | null;
  productHeight: number | null;

  // Taxonomy (denormalized to names — the POS wants names, not ids)
  departmentName: string | null;
  categoryName: string | null;

  // Stocking program
  stockFamily: string | null;

  // Vendor
  supplierName: string;

  // PO grouping (used by PO export only)
  qty: number;
  draftPoId: number | null;

  // Location for PO export. Code is the POS location code; we send
  // the StockLocation.code (e.g. "OS-WHSE", "GT-FLOOR"). The buyer's
  // existing OTB workbook uses warehouse codes that already map 1:1 to
  // these.
  stockLocationCode: string | null;

  // Apparel barcode (NULL for furniture; populated for apparel scans)
  barcode: string | null;
};

export type DraftPoForExport = {
  id: number;
  referenceNumber: string | null;
  supplierName: string;
};

// ─── Items export ──────────────────────────────────────────────────────

// User spec 2026-05-08:
//   Category, Cost Price, Department, Description, Part Number,
//   Product Name, Product Height, Product Length, Product Width,
//   Selling Price / as shown, RRP, Stock Family, Supplier
//
// Order matters — the POS reads by header position OR by header name
// depending on the import flavor; matching their canonical column order
// keeps both flavors working.
export const ITEMS_CSV_HEADERS = [
  "Category",
  "Cost Price",
  "Department",
  "Description",
  "Part Number",
  "Product Name",
  "Product Height",
  "Product Length",
  "Product Width",
  "Selling Price",
  "RRP",
  "Stock Family",
  "Supplier",
] as const;

// When ANY item in the export has a barcode, we append the column. Mixed
// batches (some apparel + some furniture) will leave the barcode cell
// empty for the furniture rows — the POS handles that fine.
export const ITEMS_CSV_BARCODE_HEADER = "Barcode";

export type BuildItemsCsvOptions = {
  /** Force-include or force-omit the Barcode column. Default: auto-detect from rows. */
  includeBarcodeColumn?: boolean;
};

export function buildItemsCsv(
  items: readonly DraftItemForExport[],
  options: BuildItemsCsvOptions = {},
): string {
  const includeBarcode =
    options.includeBarcodeColumn ?? items.some((i) => i.barcode !== null && i.barcode !== "");

  const headers: string[] = [...ITEMS_CSV_HEADERS];
  if (includeBarcode) headers.push(ITEMS_CSV_BARCODE_HEADER);

  let csv = csvRow(headers);
  for (const item of items) {
    const row: (string | number | null)[] = [
      item.categoryName ?? "",
      formatMoney(item.cost),
      item.departmentName ?? "",
      item.description ?? "",
      item.partNumber,
      item.productName,
      formatDim(item.productHeight),
      formatDim(item.productLength),
      formatDim(item.productWidth),
      formatMoney(item.retail),
      formatMoney(item.msrp),
      item.stockFamily ?? "",
      item.supplierName,
    ];
    if (includeBarcode) row.push(item.barcode ?? "");
    csv += csvRow(row);
  }
  return csv;
}

// ─── POs export ────────────────────────────────────────────────────────

// User spec 2026-05-08:
//   Supplier, Qty, Part Number, Location Code, Cost Price,
//   Description, Reference Number
//
// One row per item-line within a PO. The Reference Number repeats on
// every line of a given PO — that's how the POS groups them on import.
export const POS_CSV_HEADERS = [
  "Supplier",
  "Qty",
  "Part Number",
  "Location Code",
  "Cost Price",
  "Description",
  "Reference Number",
] as const;

export function buildPosCsv(
  pos: readonly DraftPoForExport[],
  itemsByPoId: ReadonlyMap<number, readonly DraftItemForExport[]>,
): string {
  let csv = csvRow([...POS_CSV_HEADERS]);
  for (const po of pos) {
    const items = itemsByPoId.get(po.id) ?? [];
    for (const item of items) {
      csv += csvRow([
        po.supplierName,
        item.qty,
        item.partNumber,
        item.stockLocationCode ?? "",
        formatMoney(item.cost),
        item.description ?? "",
        po.referenceNumber ?? "",
      ]);
    }
  }
  return csv;
}

// ─── Number formatting ─────────────────────────────────────────────────
//
// Money: 2 decimals, no thousands separator, no currency symbol. Dimensions:
// trim trailing zeros (so "30" not "30.00", "33.5" not "33.50") because
// some buyers type whole-inch values and the trailing decimals look noisy
// in the imported product card.

function formatMoney(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return value.toFixed(2);
}

function formatDim(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  // Trim trailing zeros after the decimal point ("30.00" → "30", "33.50" →
  // "33.5"). Round to 2 decimals first, then let parseFloat drop the noise.
  // Avoids a backtracking regex (Sonar S5852: super-linear runtime / DoS).
  return String(Number.parseFloat(value.toFixed(2)));
}

// Re-export csvCell so a future test or caller can use the same escaping.
export { csvCell } from "./csvExport";
