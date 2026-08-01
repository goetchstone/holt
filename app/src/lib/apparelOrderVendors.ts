// /app/src/lib/apparelOrderVendors.ts
//
// Vendor-format registry + pure normalizers for the Apparel Order Import
// tool. Each vendor's order file is a bit different -- even on the same
// platform -- so every format gets its own registry entry and normalizer;
// adding a vendor means adding one entry + one normalizer here.
//
// Ported from furniture-configurator's apparelOrderVendors.ts (2026-07-18
// state). ADAPTED for holt: FC's version fed a catalog-matching flow
// (Ordorite NEW-vs-UPDATE detection against existing Product rows via
// ordoriteId / UPC / style-candidate grouping). Holt's Buyer Drafts domain
// has no such concept -- every parsed row becomes a brand-new DRAFT
// BuyerDraftItem regardless of whether a similar catalog Product already
// exists (the buyer curates/links afterward via the existing barcode-lookup
// or Vendor Style picker flows). So the catalog-matching-only helpers
// (`pickBestCatalogRows`, `groupStyleCandidates`, `rankColorSuggestions`,
// `StyleCandidateRow`/`StyleCandidateMatch`, the `ordoriteId` field) were
// DROPPED. Everything else -- the format registry, part-number schemes,
// and the four normalizers -- is ported near-verbatim.
//
// Prefix adaptation: FC resolved the "Other NuOrder printout" formats
// (Hunter Bell, PISTOLA) part-number prefix from `Vendor.partNumberPrefix`
// in its DB. Holt's `Vendor` model has no such column (see
// prisma/schema.prisma `model Vendor` -- id/name/code/pricingModel/...,
// no partNumberPrefix). Rather than add a schema column for two vendors,
// the known prefixes (HBEL, PST) are hardcoded directly into the registry
// below, straight from FC's own code comments (which named the DB values).
// A brand-new printout vendor without a hardcoded prefix falls back to the
// unprefixed scheme (style-size), same as FC's fallback when no prefix was
// configured.
//
// Client-safe: the parser types are type-only imports (they erase at
// compile time, so pdf-parse stays server-only), and the CSV path is
// parsed in the browser with PapaParse then normalized here.

import { getCellValue } from "./excelUtils";
import type { NuOrderPO } from "./pricing/nuorderParser";
import type { NuOrderPrintout } from "./pricing/nuorderPrintoutParser";
import type { ZSupplyInvoice } from "./pricing/zSupplyParser";
import type { FrankEileenOrder } from "./pricing/frankEileenParser";

export type ApparelVendorFormatId =
  | "rails"
  | "rag-bone"
  | "faherty"
  | "favorite-daughter"
  | "vineyard-vines"
  | "nic-zoe"
  | "hunter-bell"
  | "pistola"
  | "nuorder-printout"
  | "nuorder"
  | "zsupply"
  | "frank-eileen"
  | "generic-csv";

export interface ApparelVendorFormat {
  id: ApparelVendorFormatId;
  label: string;
  accepts: "pdf" | "csv";
  /** Server-side parser the preview endpoint dispatches to (csv parses client-side). */
  parser: "nuorder" | "nuorder-printout" | "zsupply" | "frank-eileen" | null;
  /** Vendor name to prefill on the draft PO / draft items, when it differs from what the PDF carries. */
  catalogVendorName?: string;
  /**
   * Part-number prefix for the scheme `PREFIX-STYLE-SIZE-Color Name`.
   * Ported from FC's fbc_repro_db-verified prefixes (2026-07-14/18).
   */
  partNumberPrefix?: string;
  /**
   * Rewrites the document's style number into the catalog's spelling, for a
   * vendor whose paperwork and catalog disagree. Applied before the part
   * number is composed, so a mismatch can't silently turn every row NEW.
   */
  normalizeStyleNumber?: (style: string) => string;
  /**
   * A NEW item keys to the vendor's colour CODE rather than the colour NAME.
   * See FC's apparelOrderVendors.ts for the fbc_repro_db verification this
   * flag was pinned against (Rails is code-keyed; everyone else is name-keyed).
   */
  newItemsUseColorCode?: boolean;
  notes: string;
}

/**
 * PISTOLA prints its style with a hyphen before the variant suffix
 * ("P00051000-MK"), but its catalog spelling concatenates it
 * ("P00062114NW"). Left alone the part number gains a segment and every
 * row would look like a brand-new style on every reorder.
 */
export function stripStyleHyphens(style: string): string {
  return style.replaceAll("-", "");
}

export const APPAREL_VENDOR_FORMATS: readonly ApparelVendorFormat[] = [
  {
    id: "rails",
    label: "Rails (NuOrder PDF)",
    accepts: "pdf",
    parser: "nuorder",
    catalogVendorName: "Rails",
    partNumberPrefix: "RAI",
    newItemsUseColorCode: true,
    notes:
      "Rails NuOrder order PDFs. The Style # already ends with the color code, and Rails is " +
      "the one apparel vendor whose catalog colours are codes, so a new item keys to the code " +
      "rather than the colour name.",
  },
  {
    id: "rag-bone",
    label: "Rag & Bone (NuOrder PDF)",
    accepts: "pdf",
    parser: "nuorder",
    catalogVendorName: "Rag-Bone",
    partNumberPrefix: "RB",
    notes:
      "Rag & Bone NuOrder order PDFs. No Color Code line; the PDF often abbreviates " +
      "color names (e.g. 'lgoon') -- fix the Color column before creating the draft.",
  },
  {
    id: "faherty",
    label: "Faherty (NuOrder PDF)",
    accepts: "pdf",
    parser: "nuorder",
    catalogVendorName: "Faherty",
    partNumberPrefix: "FTY",
    notes: "Faherty Brand NuOrder order PDFs.",
  },
  {
    id: "favorite-daughter",
    label: "Favorite Daughter (NuOrder PDF)",
    accepts: "pdf",
    parser: "nuorder",
    catalogVendorName: "Favorite Daughter",
    partNumberPrefix: "FVDR",
    notes: "Favorite Daughter NuOrder order PDFs.",
  },
  {
    id: "vineyard-vines",
    label: "Vineyard Vines (NuOrder PDF)",
    accepts: "pdf",
    parser: "nuorder",
    catalogVendorName: "Vineyard Vines",
    partNumberPrefix: "VV",
    notes:
      "Vineyard Vines NuOrder order confirmations. Carries a real MSRP, so Selling prefills from it.",
  },
  {
    id: "nic-zoe",
    label: "NIC+ZOE (NuOrder PDF)",
    accepts: "pdf",
    parser: "nuorder",
    // The document says "NIC+ZOE"; the catalog spelling is "Nic-Zoe".
    catalogVendorName: "Nic-Zoe",
    partNumberPrefix: "NZ",
    notes:
      "NIC+ZOE NuOrder order confirmations. Same layout as Vineyard Vines, but every line prints " +
      "MSRP:$0.00 -- there is no retail on the document, so Selling starts blank.",
  },
  {
    id: "hunter-bell",
    label: "Hunter Bell (NuOrder printout PDF)",
    accepts: "pdf",
    parser: "nuorder-printout",
    catalogVendorName: "Hunter Bell",
    // Hardcoded (holt has no Vendor.partNumberPrefix column) -- value carried
    // over verbatim from FC's DB-seeded prefix for Hunter Bell.
    partNumberPrefix: "HBEL",
    notes: "Hunter Bell NuOrder order printouts (the tabular ORDER_Hunter-Bell_..._PO.pdf).",
  },
  {
    id: "pistola",
    label: "PISTOLA Denim (NuOrder printout PDF)",
    accepts: "pdf",
    parser: "nuorder-printout",
    // The document says "PISTOLA Denim (New)" -- the catalog spelling is "Pistola".
    catalogVendorName: "Pistola",
    // Hardcoded (holt has no Vendor.partNumberPrefix column) -- value carried
    // over verbatim from FC's DB-seeded prefix for Pistola.
    partNumberPrefix: "PST",
    normalizeStyleNumber: stripStyleHyphens,
    notes:
      "PISTOLA NuOrder order printouts (the tabular ORDER_PISTOLA-Denim-New_..._PO.pdf). TWO " +
      "quirks: the document hyphenates the style before its variant suffix (P00051000-MK) while " +
      "the catalog concatenates it (P00062114NW), so the hyphen is stripped automatically; and " +
      'the colour cell puts the CODE AFTER the name ("RACER RED RCRED") rather than before it.',
  },
  {
    id: "nuorder-printout",
    label: "Other NuOrder printout (PDF)",
    accepts: "pdf",
    parser: "nuorder-printout",
    notes:
      "The tabular NuOrder order printout (ORDER_Brand_date_PO.pdf). No known part-number " +
      "prefix -- edit the Part # column on the preview before creating the draft.",
  },
  {
    id: "nuorder",
    label: "Other NuOrder brand (PDF)",
    accepts: "pdf",
    parser: "nuorder",
    notes:
      "Any other NuOrder purchase order. Part numbers get no vendor prefix -- edit the Part # " +
      "column on the preview before creating the draft.",
  },
  {
    id: "zsupply",
    label: "Z Supply invoice PDF",
    accepts: "pdf",
    parser: "zsupply",
    catalogVendorName: "Z Supply",
    partNumberPrefix: "ZSP",
    notes:
      "Z Supply invoices (size grid format). The invoice carries only the color CODE -- " +
      "overtype the Color with a name if you have one.",
  },
  {
    id: "frank-eileen",
    label: "Frank & Eileen order PDF",
    accepts: "pdf",
    parser: "frank-eileen",
    catalogVendorName: "Frank and Eileen",
    partNumberPrefix: "FAE",
    notes:
      "Frank & Eileen order PDFs -- BOTH shapes work: the ACKNOWLEDGEMENT (size-grid columns: " +
      "XXS-XL, numeric 00-14, or O/S) and their NuOrder order printout; the tool detects which " +
      "one you gave it. Color prefills with the vendor CODE -- overtype it if you have a name.",
  },
  {
    id: "generic-csv",
    label: "Wholesale CSV",
    accepts: "csv",
    parser: null,
    notes: "Exports from NuOrder, JOOR, or any wholesale platform. Column names are auto-detected.",
  },
] as const;

/** Title-case a color name ("black/khaki" -> "Black/Khaki"). */
export function titleCaseColor(color: string): string {
  return color
    .toLowerCase()
    .replaceAll(/(^|[\s/-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Tokens that must survive a re-case verbatim. Only consulted for strings
 *  we are already rewriting (all-caps or all-lower). */
const PRESERVE_TOKENS = new Set([
  "NYC",
  "USA",
  "UK",
  "LA",
  "SF",
  "HB",
  "PU",
  "UV",
  "SS",
  "LS",
  "OS",
  "II",
  "III",
  "IV",
]);

/**
 * Re-case vendor product text for display. Only rewrites text the vendor
 * typed in ONE case -- ALL CAPS or all lower. A string carrying both cases
 * was deliberately cased by the vendor and passes through untouched.
 * Any token containing a digit is left verbatim (color codes, "2PC", sizes).
 */
export function titleCaseVendorText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  if (hasUpper && hasLower) return text;
  return trimmed
    .split(" ")
    .map((word) => (PRESERVE_TOKENS.has(word) || /\d/.test(word) ? word : titleCaseColor(word)))
    .join(" ");
}

/** Part number for the apparel vendors: PREFIX-STYLE-SIZE-Color. */
export function buildPrefixedPartNumber(
  prefix: string,
  styleNumber: string,
  size: string,
  color: string,
): string {
  return [prefix, styleNumber, size, color.trim()].filter(Boolean).join("-");
}

/** Effective part number for a row: the prefixed scheme when a prefix is
 *  known (from the format registry), else whatever the normalizer built. */
export function partNumberForRow(
  row: Pick<ApparelOrderRow, "partNumber" | "styleNumber" | "size" | "color">,
  prefix?: string,
): string {
  return prefix
    ? buildPrefixedPartNumber(prefix, row.styleNumber, row.size, row.color)
    : row.partNumber;
}

/** Leading vendor color code from a printout color cell ("PRBG Pink Red
 *  Blue Flowers" -> "PRBG"; "1984 Washed Blue" -> "1984"; "Lost At Sea" ->
 *  null). Codes are 2-4 caps/digits, printed before the spelled-out name. */
export function leadingColorCode(colorCell: string): string | null {
  const m = /^([A-Z0-9]{2,4})(?:\s|$)/.exec(colorCell.trim());
  return m ? m[1] : null;
}

/** Split a part number of the shape `PREFIX-STYLE-SIZE-Color` back into
 *  size + color, given the known prefix and style. Returns null when the
 *  row doesn't follow the shape. */
export function extractSizeAndColor(
  partNumber: string,
  prefix: string,
  styleNumber: string,
): { size: string; color: string } | null {
  const head = `${prefix}-${styleNumber}-`;
  if (!partNumber.startsWith(head)) return null;
  const rest = partNumber.slice(head.length);
  const dash = rest.indexOf("-");
  if (dash <= 0) return null;
  const size = rest.slice(0, dash);
  const color = rest.slice(dash + 1).trim();
  if (!color) return null;
  return { size, color };
}

// Column alias map for the generic CSV path (NuOrder, JOOR, manual exports).
export const CSV_COLUMN_ALIASES: Record<string, string[]> = {
  vendor: ["Vendor", "vendor", "Brand", "brand", "Supplier", "supplier"],
  productNumber: [
    "Style",
    "style",
    "SKU",
    "sku",
    "Style #",
    "StyleNumber",
    "ProductNumber",
    "part_no",
    "partNo",
    "Item #",
    "Item Number",
  ],
  productName: [
    "Description",
    "description",
    "Product",
    "product",
    "Product Name",
    "ProductName",
    "name",
    "Style Name",
    "Item Description",
  ],
  quantity: [
    "Qty",
    "qty",
    "QTY",
    "Quantity",
    "quantity",
    "Units",
    "units",
    "Order Qty",
    "Order QTY",
    "ORDER QTY",
    "Ordered Qty",
    "Ordered QTY",
    "Ordered",
    "ordered",
    "Order Quantity",
    "Ordered Quantity",
    "Total Qty",
    "Total QTY",
    "Total Quantity",
    "total_qty",
    "QTY Ordered",
    "Qty Ordered",
    "# Units",
    "No. of Units",
  ],
  cost: [
    "Wholesale",
    "wholesale",
    "Cost",
    "cost",
    "Unit Cost",
    "unitCost",
    "Price",
    "Wholesale Price",
  ],
  retail: ["Retail", "retail", "MSRP", "msrp", "Retail Price", "retailPrice", "Suggested Retail"],
  upc: ["UPC", "upc", "Barcode", "barcode", "EAN", "ean", "GTIN", "gtin"],
  color: ["Color", "color", "Colorway", "colorway", "Color Name"],
  size: ["Size", "size", "Dimension", "dimension"],
  department: ["Department", "department", "Division", "division"],
  category: ["Category", "category", "SubFamily", "Collection", "collection"],
  type: ["Type", "type", "SubCategory"],
  season: ["Season", "season", "Family", "Delivery", "delivery", "Ship Window"],
  notes: ["Notes", "notes", "Comments", "comments", "Order Notes"],
};

// ─── Row shape ─────────────────────────────────────────────────────────
//
// One row per size-variant -- this is the unit the Buyer Drafts mapping
// (lib/apparelOrderToBuyerDraft.ts) turns 1:1 into a BuyerDraftItem create
// body. NOT the same shape as FC's ApparelExportRow: no `ordoriteId`
// (holt doesn't catalog-match), no `oversell` / `reference` /
// `excludeFromPo` (those were Ordorite CSV-export-only concerns; holt's PO
// export already exists in lib/buyerDraftExport.ts and works off the DB
// rows this tool creates).
export interface ApparelOrderRow {
  partNumber: string;
  styleNumber: string;
  productName: string;
  color: string;
  /** Vendor color CODE when the document carries one distinctly from the name. */
  colorCode?: string;
  size: string;
  qty: number;
  cost: number;
  msrp: number | null;
  /** Proposed retail/selling price; defaults to MSRP in the UI. */
  selling: number | null;
  /** Vendor's season / delivery-window label. */
  season: string;
  department: string;
  category: string;
  /** Vendor / supplier name as read off the document (or the registry's catalogVendorName). */
  supplier: string;
  /** Vendor UPC, when the document carries one. */
  barcode: string;
}

export interface ApparelOrderDraft {
  vendorName: string;
  poNumber: string;
  orderNumber: string;
  orderDate: string;
  season: string;
  rows: ApparelOrderRow[];
  /** Lines the parser refused to guess -- shown in the preview. */
  warnings?: string[];
}

function baseRow(): Pick<ApparelOrderRow, "department" | "category" | "barcode"> {
  return { department: "", category: "", barcode: "" };
}

// Part-number schemes:
//   NuOrder sized:    `${style}-${colorCode}-${size}`
//   NuOrder sizeless: bare styleNumber
//   Z Supply:         `${style}-${colorCode}-${size||"OS"}`
//   Generic CSV:      [style, color, size].join("-")
// (mirrors FC's parked local-write importers so a reorder's part number
// keeps matching what an earlier import created)

export function normalizeNuOrder(
  parsed: NuOrderPO,
  format?: ApparelVendorFormat,
): ApparelOrderDraft {
  const prefix = format?.partNumberPrefix;
  const vendorName = format?.catalogVendorName || parsed.vendorName;
  const rows: ApparelOrderRow[] = [];
  for (const item of parsed.items) {
    const color = prefix ? titleCaseColor(item.color) : item.color;
    const partNumberFor = (size: string) => {
      if (prefix) return buildPrefixedPartNumber(prefix, item.styleNumber, size, color);
      if (!size) return item.styleNumber;
      return [item.styleNumber, item.colorCode, size].filter(Boolean).join("-");
    };
    const shared = {
      ...baseRow(),
      styleNumber: item.styleNumber,
      productName: titleCaseVendorText(item.productName),
      color,
      colorCode: item.colorCode || undefined,
      cost: item.unitPrice,
      msrp: item.msrp || null,
      selling: item.msrp || null,
      season: item.season,
      supplier: vendorName,
    };
    if (item.sizes.length > 0) {
      for (const s of item.sizes) {
        rows.push({ ...shared, partNumber: partNumberFor(s.size), size: s.size, qty: s.quantity });
      }
    } else {
      rows.push({ ...shared, partNumber: partNumberFor(""), size: "", qty: item.totalUnits });
    }
  }
  return {
    vendorName,
    poNumber: parsed.poNumber,
    orderNumber: parsed.orderNumber,
    orderDate: parsed.orderDate,
    season: rows.find((r) => r.season)?.season ?? "",
    rows,
  };
}

export function normalizeNuOrderPrintout(
  parsed: NuOrderPrintout,
  format?: ApparelVendorFormat,
): ApparelOrderDraft {
  const prefix = format?.partNumberPrefix;
  const vendorName = format?.catalogVendorName || parsed.vendorName;
  const rows: ApparelOrderRow[] = [];
  for (const item of parsed.items) {
    const styleNumber = format?.normalizeStyleNumber?.(item.styleNumber) ?? item.styleNumber;
    const code = leadingColorCode(item.colorCode);
    let color: string;
    if (code) {
      color = code;
    } else if (item.colorCode === item.colorCode.toUpperCase()) {
      color = titleCaseColor(item.colorCode);
    } else {
      color = item.colorCode;
    }
    for (const s of item.sizes) {
      // One-size suffix is "OS" (the printed scale says "O/S").
      const size = s.size === "O/S" ? "OS" : s.size;
      rows.push({
        ...baseRow(),
        partNumber: prefix
          ? buildPrefixedPartNumber(prefix, styleNumber, size, color)
          : [styleNumber, size].filter(Boolean).join("-"),
        styleNumber,
        productName: titleCaseVendorText(item.productName),
        color,
        colorCode: code ?? undefined,
        size,
        qty: s.quantity,
        cost: item.unitPrice,
        msrp: item.msrp || null,
        selling: item.msrp || null,
        season: parsed.season,
        supplier: vendorName,
      });
    }
  }
  const warnings = [...parsed.warnings];
  if (parsed.cancelled.items > 0) {
    warnings.push(
      `${parsed.cancelled.items} cancelled style(s) excluded: ` +
        `${parsed.cancelled.units} units, $${parsed.cancelled.total.toFixed(2)}`,
    );
  }
  return {
    vendorName,
    poNumber: parsed.poNumber,
    orderNumber: "",
    orderDate: parsed.orderDate,
    season: parsed.season,
    rows,
    warnings,
  };
}

export function normalizeZSupply(
  parsed: ZSupplyInvoice,
  format?: ApparelVendorFormat,
): ApparelOrderDraft {
  const prefix = format?.partNumberPrefix;
  const vendorName = format?.catalogVendorName || parsed.vendorName;
  const rows: ApparelOrderRow[] = parsed.items.map((item) => {
    const size = item.size || "OS";
    return {
      ...baseRow(),
      partNumber: prefix
        ? buildPrefixedPartNumber(prefix, item.styleNumber, size, item.colorCode)
        : `${item.styleNumber}-${item.colorCode}-${size}`,
      styleNumber: item.styleNumber,
      productName: titleCaseVendorText(item.productName),
      color: item.colorCode,
      colorCode: item.colorCode || undefined,
      size,
      qty: item.quantity,
      cost: item.unitPrice,
      msrp: null,
      selling: null,
      season: "",
      supplier: vendorName,
    };
  });
  return {
    vendorName,
    poNumber: parsed.poNumber,
    orderNumber: parsed.orderNumber || parsed.invoiceNumber,
    orderDate: parsed.invoiceDate,
    season: "",
    rows,
  };
}

/**
 * Frank & Eileen's retail convention: retail = cost x 2.3 rounded to the
 * nearest price ending in 8. Ported from FC (fbc_repro_db, 2026-07-14).
 * Prefill only -- editable per row in the preview.
 */
export function frankEileenRetail(cost: number): number | null {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const base = cost * 2.3;
  const down = Math.floor((base - 8) / 10) * 10 + 8;
  const up = down + 10;
  return base - down <= up - base ? down : up;
}

export function normalizeFrankEileen(parsed: FrankEileenOrder): ApparelOrderDraft {
  const rows: ApparelOrderRow[] = [];
  for (const item of parsed.items) {
    for (const s of item.sizes) {
      const size = s.size === "O/S" ? "OS" : s.size;
      rows.push({
        ...baseRow(),
        partNumber: buildPrefixedPartNumber("FAE", item.styleNumber, size, item.colorCode),
        styleNumber: item.styleNumber,
        productName: titleCaseVendorText(item.description),
        color: item.colorCode,
        colorCode: item.colorCode || undefined,
        size,
        qty: s.quantity,
        cost: item.unitPrice,
        msrp: null,
        selling: frankEileenRetail(item.unitPrice),
        season: parsed.season,
        supplier: parsed.vendorName,
      });
    }
  }
  return {
    vendorName: parsed.vendorName,
    poNumber: parsed.poNumber,
    orderNumber: parsed.ackNumber,
    orderDate: parsed.orderDate,
    season: parsed.season,
    rows,
    warnings: parsed.warnings,
  };
}

/** Trimmed string cell for one of the CSV_COLUMN_ALIASES groups. */
function csvString(raw: Record<string, unknown>, aliases: string[]): string {
  return String(getCellValue(raw, aliases) ?? "").trim();
}

/** Numeric cell, or `fallback` when blank/non-numeric/non-positive. */
function csvPositiveNumber(
  raw: Record<string, unknown>,
  aliases: string[],
  fallback: number,
): number {
  const n = Number(getCellValue(raw, aliases));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** One CSV row's worth of ApparelOrderRow fields, given the vendor already
 *  resolved for the batch (see normalizeCsvRows -- kept out-of-line so the
 *  loop body stays under the cognitive-complexity budget). */
function csvRowToApparelRow(
  raw: Record<string, unknown>,
  style: string,
  vendor: string,
): ApparelOrderRow {
  const color = csvString(raw, CSV_COLUMN_ALIASES.color);
  const size = csvString(raw, CSV_COLUMN_ALIASES.size);
  const costRaw = Number(getCellValue(raw, CSV_COLUMN_ALIASES.cost));
  const retail = csvPositiveNumber(raw, CSV_COLUMN_ALIASES.retail, 0) || null;
  return {
    ...baseRow(),
    partNumber: [style, color, size].filter(Boolean).join("-"),
    styleNumber: style,
    productName: titleCaseVendorText(csvString(raw, CSV_COLUMN_ALIASES.productName) || style),
    color,
    size,
    qty: csvPositiveNumber(raw, CSV_COLUMN_ALIASES.quantity, 1),
    cost: Number.isFinite(costRaw) ? costRaw : 0,
    msrp: retail,
    selling: retail,
    season: csvString(raw, CSV_COLUMN_ALIASES.season),
    department: csvString(raw, CSV_COLUMN_ALIASES.department),
    category: csvString(raw, CSV_COLUMN_ALIASES.category),
    supplier: vendor,
    barcode: csvString(raw, CSV_COLUMN_ALIASES.upc),
  };
}

/** Generic CSV rows (already parsed client-side with PapaParse). Rows
 *  missing a style/SKU are skipped and reported back for the preview. */
export function normalizeCsvRows(csvRows: Record<string, unknown>[]): ApparelOrderDraft & {
  skipped: number;
  vendorNames: string[];
} {
  const rows: ApparelOrderRow[] = [];
  let skipped = 0;
  let vendorName = "";
  const vendorNames: string[] = [];
  for (const raw of csvRows) {
    const style = csvString(raw, CSV_COLUMN_ALIASES.productNumber);
    if (!style) {
      skipped++;
      continue;
    }
    const vendor = csvString(raw, CSV_COLUMN_ALIASES.vendor);
    if (vendor && !vendorName) vendorName = vendor;
    if (vendor && !vendorNames.includes(vendor)) vendorNames.push(vendor);
    rows.push(csvRowToApparelRow(raw, style, vendor));
  }
  // Rows without their own vendor column inherit the first one seen.
  for (const r of rows) {
    if (!r.supplier) r.supplier = vendorName;
  }
  return {
    vendorName,
    poNumber: "",
    orderNumber: "",
    orderDate: "",
    season: rows.find((r) => r.season)?.season ?? "",
    rows,
    skipped,
    vendorNames,
  };
}
