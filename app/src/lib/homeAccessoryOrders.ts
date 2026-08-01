// /app/src/lib/homeAccessoryOrders.ts
//
// Vendor-format registry + pure normalizer for the Home Accessory Order
// Import tool. Ported from furniture-configurator's
// src/lib/homeAccessoryOrders.ts and ADAPTED to holt's Buyer Drafts pipeline:
// FC's version fed the Ordorite CSV builders (files-only, no DB writes)
// because Ordorite is FC's system of record. Holt IS its own system of
// record, so this tool's output is `BuyerDraftPurchaseOrder` +
// `BuyerDraftItem` rows (see `homeAccessoryBuyerDraftMapping.ts`) instead of
// an Ordorite import CSV.
//
// The only real adaptation in THIS file is the row shape: FC's normalizers
// produced `ApparelExportRow` (an Ordorite-CSV-shaped type shared with the
// apparel tool). Holt has no such type, so this file defines its own
// `HomeAccessoryExportRow` — same fields, same precedence rules, just not
// tied to Ordorite's CSV columns. Every normalizer function, the split-set
// math, and the markup/rounding rules are otherwise unchanged from FC.
//
// Client-safe: the vendor-order types (KKOrderBundle, WendoverOrder, etc.)
// are type-only imports — the actual PDF/CSV parsing (pdf-parse / papaparse)
// runs server-side in lib/pricing/*, so importing the type here erases at
// compile time and this file stays safe for the browser bundle that hosts
// the import page.

import type { KKOrderBundle } from "./pricing/kkOrderParser";
import type { WendoverOrder } from "./pricing/wendoverOrderParser";
import type { MarketTimeOrder } from "./pricing/marketTimeOrderParser";
import type { BrandWiseOrder } from "./pricing/brandWiseOrderParser";
import type { AestheticMovementOrder } from "./pricing/aestheticMovementOrderParser";
import type { SuperCatOrder } from "./pricing/superCatOrderParser";
import type { SimblistOrder } from "./pricing/simblistCsvOrderParser";
import type { BeatrizBallOrder } from "./pricing/beatrizBallOrderParser";

/**
 * Match two supplier names tolerant of "&" vs "and" (mirrors FC's
 * 2026-07-17 direction — vendors' order PDFs print "&" where a catalog may
 * store "and", or vice versa). Both sides normalize the same way, so a
 * vendor genuinely stored with "&" ("Graf & Lantz Inc") still matches itself.
 */
export function normalizeSupplier(name: string): string {
  return name.toLowerCase().replaceAll("&", "and").replaceAll(/\s+/g, " ").trim();
}
export function sameSupplier(a: string, b: string): boolean {
  return normalizeSupplier(a) === normalizeSupplier(b);
}

export type HomeAccessoryFormatId =
  | "kk-interiors"
  | "wendover"
  | "market-time"
  | "brandwise-zodax"
  | "aesthetic-movement"
  | "supercat"
  | "maison-zoe-ford"
  | "beatriz-ball";

export interface HomeAccessoryFormat {
  id: HomeAccessoryFormatId;
  label: string;
  /** Upload type the format expects. Most vendors ship a PDF; Simblist Group
   *  exports a CSV. Drives the file picker's accept filter and the server's
   *  upload preset. */
  accepts: "pdf" | "csv";
  parser:
    | "kk-order"
    | "wendover-order"
    | "market-time"
    | "brandwise"
    | "aesthetic-movement"
    | "supercat"
    | "simblist-csv"
    | "beatriz-ball";
  /**
   * Exact catalog vendor name, for a format that IS one vendor's own
   * document (K&K's order detail, Wendover's confirmation email).
   *
   * Omitted when the DOCUMENT carries the supplier: MarketTime prints
   * "MFR: <name>", and several vendors' reps write on that same form, so
   * pinning one name here would be wrong for all the others.
   */
  catalogVendorName?: string;
  notes: string;
}

export const HOME_ACCESSORY_FORMATS: readonly HomeAccessoryFormat[] = [
  {
    id: "kk-interiors",
    label: "K & K Interiors (Order Detail PDF)",
    accepts: "pdf",
    parser: "kk-order",
    catalogVendorName: "K & K Interiors",
    notes:
      "K & K's Order Detail PDF bundles several orders into one file, each with its " +
      "own order number and required date — this tool turns each order into its own " +
      "draft PO. Items printed as a multi-piece 'Set of N' are NOT split automatically; " +
      "splitting a set into separate draft items (and dividing the set's cost across " +
      "them) is a buyer decision made in the preview, not an import-time default. No " +
      "part-number prefix here — it comes from the vendor record (Vendor.code).",
  },
  {
    id: "wendover",
    label: "Wendover Art Group (order confirmation email PDF)",
    accepts: "pdf",
    parser: "wendover-order",
    catalogVendorName: "Wendover Art Group",
    notes:
      "Wendover confirms orders by email with no attachment, so the document here is the " +
      "buyer's print-to-PDF of that confirmation. One PDF is one order. The vendor's Price " +
      "column is the LINE TOTAL, not the unit price — the unit cost this tool wants is " +
      "derived from it. Art is never sold as a set, so the split panel does not apply. Items " +
      "printed with a Side Mark are already sold to a customer rather than bought as stock.",
  },
  {
    id: "market-time",
    label: "MarketTime PO (Graf & Lantz, Simon & Schuster, Graphique, and other reps' vendors)",
    accepts: "pdf",
    parser: "market-time",
    // NO catalogVendorName on purpose: the document names its own
    // manufacturer on its "MFR:" line, and several vendors' reps use this
    // same form, so one pinned name would be wrong for the rest. The
    // supplier box is prefilled from the document and stays editable.
    notes:
      "MarketTime's PO form, written by a rep (Harper Group writes Graf & Lantz on it). " +
      "The supplier is read from the document, so this one entry serves every vendor whose " +
      "rep uses the form. Unlike Wendover, the Price column is the UNIT price and Total is " +
      "the extension. Unlike K&K and Wendover, the UPCs are real 12-digit manufacturer " +
      "codes, so new items carry them. The document can be a QUOTE rather than a placed " +
      "order -- a hold note is surfaced when one is printed.",
  },
  {
    id: "brandwise-zodax",
    label: "BrandWise Sales Order (Zodax)",
    accepts: "pdf",
    parser: "brandwise",
    catalogVendorName: "Zodax",
    notes:
      "BrandWise is the platform; Zodax writes orders on it. The money line is qty + UOM + " +
      'unit price + line total with NO dollar sign ("4EA200.00800.00"), settled by qty x ' +
      "price == total. There is NO UPC column, so barcodes stay blank. BrandWise does not " +
      "print the manufacturer, so the supplier defaults to Zodax -- edit it and Re-check for " +
      "another BrandWise vendor.",
  },
  {
    id: "aesthetic-movement",
    label: "Aesthetic Movement PO (Printworks and other repped brands)",
    accepts: "pdf",
    parser: "aesthetic-movement",
    // NO catalogVendorName on purpose: Aesthetic Movement reps several brands
    // and the form prints "Vendor: <name>", so the supplier is read from the
    // document and this one entry serves every brand on the form.
    notes:
      "Aesthetic Movement's PO form (Printworks writes orders on it). The money line has " +
      'dollar signs -- "12$33.00$396.00" (qty $unit price $line total) -- so the split is ' +
      "unambiguous, and qty x price == total is still checked. UPCs are real 13-digit " +
      "manufacturer codes when present, but an out-of-stock item can print none, in which " +
      'case the barcode stays blank. The supplier is read from the "Vendor:" line.',
  },
  {
    id: "supercat",
    label: "SuperCatSolutions PO (Jamie Young and other repped brands)",
    accepts: "pdf",
    parser: "supercat",
    // NO catalogVendorName on purpose: "Powered by SuperCatSolutions.com" reps
    // several brands and the vendor's name prints at the top of the document,
    // so the supplier is read from it and this entry serves every brand.
    notes:
      "SuperCatSolutions' order form (Jamie Young writes orders on it). Each item is one " +
      'run-together line -- "9BOATLINEG6$285.00$1,710.00Boa Table Lamp" (item + qty + $unit ' +
      "price + $extension + description) -- split by the two dollar amounts and confirmed by " +
      "qty x price == extension. There is NO UPC column, so barcodes stay blank. An " +
      "order-level discount is NOT applied to the unit costs automatically -- it is surfaced " +
      "as a warning so the buyer applies it deliberately.",
  },
  {
    id: "maison-zoe-ford",
    label: "Simblist Group CSV (Maison Zoe Ford and other repped brands)",
    accepts: "csv",
    parser: "simblist-csv",
    // NO catalogVendorName on purpose: Simblist Group reps several brands and
    // the CSV carries the real Manufacturer in a column, read from the file.
    notes:
      "Simblist Group's order-export CSV (Maison Zoe Ford writes orders through it). Upload " +
      "the CSV, not the PDF. Columns are read by name, and qty x Unit Price == Total Price is " +
      "checked on every line. UPCs are real 14-digit case codes, so new items carry them. An " +
      "order-level discount (line totals summing above the order total) is NOT applied to the " +
      "unit costs automatically -- it is surfaced as a warning.",
  },
  {
    id: "beatriz-ball",
    label: "Beatriz Ball (Sales Order PDF)",
    accepts: "pdf",
    parser: "beatriz-ball",
    // The vendor's name is a letterhead image, not text, so it is pinned here.
    catalogVendorName: "Beatriz Ball",
    notes:
      "Beatriz Ball's Sales Order PDF. Each item is one run-together line (item code + line " +
      "amount + MSRP + wholesale unit price + qty + description); the item-code / amount " +
      "boundary is settled by wholesale x qty == amount. Descriptions can wrap across two " +
      "lines and are rejoined. There is NO UPC column, so barcodes stay blank. Unlike the " +
      "other vendors, the MSRP column is real, so it prefills the retail price.",
  },
] as const;

/** Draft part number for home-accessory items: PREFIX-ITEMNUMBER[-SUFFIX].
 *  The vendor's own colour code (e.g. "-YE") already lives inside itemNumber
 *  on non-split items — never re-derive it. SUFFIX is only for a
 *  buyer-split set component ("KKI-17695A-LG" for the "LG" piece). */
export function buildHomeAccessoryPartNumber(
  prefix: string,
  itemNumber: string,
  suffix?: string,
): string {
  return [prefix.trim(), itemNumber.trim(), suffix?.trim()].filter(Boolean).join("-");
}

/** Buyer-facing hint only — this never triggers an automatic split. Verified
 *  trap: UOM is NOT a reliable set signal (K&K "90021D-NA" ships UOM "EA"
 *  yet its description reads "Set of 3 Stackable Natural Wood Cake Plates
 *  w/Glass Cloches"), so only the description text is consulted, never uom. */
export function detectSetSize(description: string): number | null {
  const match = /^\s*set of (\d+)/i.exec(description);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Even split of a set's unit price across its component rows, worked in
 *  whole cents so the parts always sum to exactly setPrice (floating-point
 *  division risks 0.1 + 0.2-style drift). Any leftover cent lands on the
 *  first part. This is a PREFILL only — the real allocations are
 *  size-weighted buyer judgement and every row is edited before commit; the
 *  invariant that matters is that the parts always reconcile to the set
 *  price. */
export function splitSetCosts(setPrice: number, parts: number): number[] {
  if (parts < 1) return [];
  const totalCents = Math.round(setPrice * 100);
  const baseCents = Math.trunc(totalCents / parts);
  const remainderCents = totalCents - baseCents * parts;
  const cents = new Array<number>(parts).fill(baseCents);
  cents[0] += remainderCents;
  return cents.map((c) => c / 100);
}

/**
 * The size word a split suffix stands for. The buyer types the suffix (LG/MD/
 * SM are only a prefill), so anything unrecognised is used as-is rather than
 * guessed at.
 */
const SUFFIX_WORDS: Readonly<Record<string, string>> = {
  LG: "Large",
  L: "Large",
  MD: "Medium",
  M: "Medium",
  SM: "Small",
  S: "Small",
  XL: "X-Large",
  XS: "X-Small",
};

export function splitSuffixWord(suffix: string): string {
  const key = suffix.trim().toUpperCase();
  return SUFFIX_WORDS[key] ?? suffix.trim();
}

/**
 * A split piece's name, from the set's name and the piece's suffix (mirrors
 * FC's 2026-07-17 direction: "when we split something we should
 * automatically change the descriptions, remove set and add the suffix we
 * are adding to the part number, like small, medium, large").
 *
 * Two things that convention does which this deliberately does NOT do:
 * singularise ("Candleholders" -> "Candleholder"), and insert the size
 * mid-name. There is no rule to copy — this is a prefill the buyer
 * overtypes, like the split percentages.
 */
export function splitPieceName(setName: string, suffix: string): string {
  const withoutSet = setName.replace(/^\s*set of \d+\s*/i, "").trim();
  const word = splitSuffixWord(suffix);
  if (!word) return withoutSet || setName.trim();
  if (!withoutSet) return word;
  return `${withoutSet} ${word}`;
}

export interface SplitPreset {
  label: string;
  percents: number[];
}

/**
 * The split shapes the buyer actually uses, by number of pieces (ported
 * verbatim from FC — grounded in real K&K split-cost data, per FC's rule 41
 * backing):
 *   3 pieces: 40/35/25 leads, then 45/33/22, then 50/30/20
 *   2 pieces: 62/38 leads, then 60/40, then 67/33
 * So the pieces of a set are priced by a chosen SHAPE, not by dividing
 * evenly — the first entry for each size is the prefill, and every
 * percentage stays editable.
 */
export const SPLIT_PRESETS: Readonly<Record<number, readonly SplitPreset[]>> = {
  2: [
    { label: "62 / 38", percents: [62, 38] },
    { label: "60 / 40", percents: [60, 40] },
    { label: "67 / 33", percents: [67, 33] },
    { label: "Even", percents: [50, 50] },
  ],
  3: [
    { label: "40 / 35 / 25", percents: [40, 35, 25] },
    { label: "45 / 33 / 22", percents: [45, 33, 22] },
    { label: "50 / 30 / 20", percents: [50, 30, 20] },
    { label: "Even", percents: [100 / 3, 100 / 3, 100 / 3] },
  ],
};

/** The prefill shape for a set of `parts` pieces: the dominant shape where
 *  we have one, else an even share. */
export function defaultSplitPercents(parts: number): number[] {
  const preset = SPLIT_PRESETS[parts]?.[0];
  if (preset) return [...preset.percents];
  if (parts < 1) return [];
  return new Array<number>(parts).fill(100 / parts);
}

/**
 * A set's unit price allocated across its pieces by percentage, worked in
 * whole cents so the parts sum to exactly setPrice. Rounding leftovers land
 * on the LARGEST piece, where a cent is least visible.
 *
 * Percentages that do not total 100 are honoured as literal shares of the
 * set price (40/35/20 spends only 95% of it) rather than silently
 * normalised — the shortfall then shows up in the preview's reconciliation
 * instead of being hidden.
 */
export function splitCostsByPercent(setPrice: number, percents: readonly number[]): number[] {
  if (percents.length === 0) return [];
  const totalCents = Math.round(setPrice * 100);
  const cents = percents.map((p) => Math.round((totalCents * p) / 100));
  const sum = cents.reduce((a, b) => a + b, 0);
  const exact = Math.abs(percents.reduce((a, b) => a + b, 0) - 100) < 1e-9;
  if (exact && sum !== totalCents) {
    let largest = 0;
    for (let i = 1; i < cents.length; i++) {
      if (cents[i] > cents[largest]) largest = i;
    }
    cents[largest] += totalCents - sum;
  }
  return cents.map((c) => c / 100);
}

/** A piece's share of its set, for display next to an adopted or typed
 *  cost. Returns 0 when the set has no price to take a share of. */
export function costPercent(cost: number, setPrice: number): number {
  if (setPrice <= 0) return 0;
  return (cost / setPrice) * 100;
}

/**
 * A markup-derived retail, rounded UP to a price ending in 5 or 9.
 *
 * Mirrors FC's 2026-07-17 direction: "if we are setting the price via
 * markup (the vendor is not showing an msrp) then ensure we round up to a
 * 5 or 9." None of these vendors print a retail at all, so the markup is
 * always the source and this always applies.
 *
 * Whole dollars, no cents, and the dollar digit lands on 5 or 9:
 *   210 -> 215, 211 -> 215, 215 -> 215, 216 -> 219, 219 -> 219, 220 -> 225
 *
 * Always UP, never down: rounding a markup DOWN would quietly sell below the
 * margin the buyer typed.
 */
export function roundRetailUpToFiveOrNine(value: number): number {
  if (value <= 0) return 0;
  const whole = Math.ceil(value);
  const last = whole % 10;
  // 0-5 -> this decade's 5; 6-9 -> this decade's 9.
  return last <= 5 ? whole - last + 5 : whole - last + 9;
}

export function applyMarkup(cost: number, markup: number): number | null {
  if (!Number.isFinite(markup) || markup <= 0) return null;
  if (cost <= 0) return null;
  return roundRetailUpToFiveOrNine(cost * markup);
}

/**
 * One parsed + normalized order line, before split/markup/classification
 * edits are applied. Holt-native replacement for FC's `ApparelExportRow` —
 * same fields (minus the couple that only ever meant anything for
 * apparel), not tied to any Ordorite CSV column shape. `homeAccessoryRows.ts`
 * expands this into `EffectiveRow`s (plain line -> 1 row; split set -> 1 row
 * per piece), and `homeAccessoryBuyerDraftMapping.ts` maps THOSE into the
 * `BuyerDraftItem` / `BuyerDraftPurchaseOrder` create payloads.
 */
export interface HomeAccessoryExportRow {
  partNumber: string;
  styleNumber: string;
  productName: string;
  /** Not used by any home-accessory vendor today (kept for shape parity with
   *  the apparel tool's row type and in case a future vendor prints one). */
  color: string;
  /** Wendover's printed art dimension ("35.01\"w x 41.01\"h") rides here —
   *  folded into the description by `wendoverDescription`, not used as a
   *  standalone field downstream. */
  size: string;
  qty: number;
  cost: number;
  msrp: number | null;
  /** Retail; defaults to MSRP in the UI. */
  selling: number | null;
  department: string;
  category: string;
  supplier: string;
  /** Vendor UPC. "" means the vendor's document carries none — downstream
   *  this leaves BuyerDraftItem.barcode null rather than fabricating one. */
  barcode: string;
  /**
   * Long-form description. Omitted -> the UI falls back to the row's own
   * productName. Editable per row: the vendor's wording is not always what
   * should sit on the shelf tag.
   */
  description?: string;
  /**
   * The vendor's own order number (or a buyer-typed override) — the
   * grouping key for which draft PO a row lands on. One document can hold
   * SEVERAL orders (a K&K bundle carries two), and each becomes its own
   * `BuyerDraftPurchaseOrder`.
   */
  reference?: string;
  /** Run-level Ordorite-style stocking-program label, written onto the row
   *  by `composeHomeAccessoryRows` (not parsed from any vendor document —
   *  no home-accessory vendor prints one). Maps to `BuyerDraftItem.
   *  stockFamily`. */
  stockFamily?: string;
}

export interface HomeAccessoryDraft {
  vendorName: string;
  customerPo: string;
  orderDate: string;
  /** Per-order summary for the page's header — one draft PO gets created
   *  per entry, via each row's `reference`. */
  orders: { orderNumber: string; requiredDate: string; itemCount: number }[];
  rows: HomeAccessoryExportRow[];
  /** Carried through from the bundle verbatim — the parser already applied
   *  the refuse-to-guess doctrine while reading the PDF. */
  warnings: string[];
}

function baseRow(): Pick<
  HomeAccessoryExportRow,
  "color" | "size" | "msrp" | "selling" | "department" | "category"
> {
  return {
    color: "",
    size: "",
    msrp: null,
    selling: null,
    department: "",
    category: "",
  };
}

export function normalizeKKBundle(
  bundle: KKOrderBundle,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || bundle.vendorName;
  const orders: HomeAccessoryDraft["orders"] = [];
  const rows: HomeAccessoryExportRow[] = [];
  for (const order of bundle.orders) {
    orders.push({
      orderNumber: order.orderNumber,
      requiredDate: order.requiredDate,
      itemCount: order.items.length,
    });
    for (const item of order.items) {
      rows.push({
        ...baseRow(),
        // Bare vendor item number — the page re-keys it with the vendor
        // record's Vendor.code.
        partNumber: item.itemNumber,
        styleNumber: item.itemNumber,
        productName: item.description,
        qty: item.qty,
        // The PDF's unit price IS the wholesale cost.
        // msrp/selling stay null — the document carries no retail at all;
        // the optional markup prefill fills them in on the page.
        cost: item.unitPrice,
        supplier: vendorName,
        // Manufacturer UPC.
        barcode: item.upc,
        // The owning order's number — this is what makes one bundle create
        // SEVERAL draft POs (one per distinct reference).
        reference: order.orderNumber,
      });
    }
  }
  return {
    vendorName,
    customerPo: bundle.customerPo,
    orderDate: bundle.orderDate,
    orders,
    rows,
    warnings: [...bundle.warnings],
  };
}

/**
 * Long-form description in the shape "Medium: X Treatment: Y Size: Z Frame:
 * W" (mirrors the PDF's own labels). Values are carried verbatim. Every
 * description stays editable per row.
 */
export function wendoverDescription(item: WendoverOrder["items"][number]): string {
  const parts = [
    item.medium && `Medium: ${item.medium}`,
    item.treatment && `Treatment: ${item.treatment}`,
    item.size && `Size: ${item.size}`,
    item.frame && `Frame: ${item.frame}`,
    ...item.extras,
  ];
  return parts.filter(Boolean).join(" ");
}

export function normalizeWendoverOrder(
  order: WendoverOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || order.vendorName;
  const warnings = [...order.warnings];

  // A Side Mark means the piece is already sold to a named customer, so it
  // is not stock arriving to sell. Surfaced rather than silently imported
  // as ordinary inventory.
  const sold = order.items.filter((i) => i.sideMark);
  if (sold.length > 0) {
    warnings.push(
      `${sold.length} item(s) carry a Side Mark (already sold to a customer): ` +
        sold.map((i) => `${i.sku} → ${i.sideMark}`).join(", "),
    );
  }

  const rows: HomeAccessoryExportRow[] = order.items.map((item) => ({
    ...baseRow(),
    // Bare vendor SKU — the page re-keys it with the vendor record's
    // Vendor.code ("WAG"), same as the K&K rows.
    partNumber: item.sku,
    styleNumber: item.sku,
    productName: item.name,
    // The printed Size is the piece's real dimension; it also rides into
    // the description via wendoverDescription.
    size: item.size,
    description: wendoverDescription(item),
    qty: item.qty,
    // Derived: the document prints the LINE TOTAL; unit cost is derived by
    // the parser. See wendoverOrderParser.ts for the proof.
    cost: item.unitPrice,
    supplier: vendorName,
    // Wendover's confirmation carries no manufacturer UPC — blank leaves
    // BuyerDraftItem.barcode unset.
    barcode: "",
    reference: order.orderNumber,
  }));

  return {
    vendorName,
    customerPo: "",
    orderDate: order.orderDate,
    orders: [
      {
        orderNumber: order.orderNumber,
        requiredDate: "",
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings,
  };
}

/**
 * A Graf & Lantz / MarketTime order as export rows.
 *
 * The Price column here is the UNIT price already (verified in FC: qty x
 * price == total on all 11 lines of PON09057), so unlike Wendover nothing
 * is derived -- the cost is taken as printed.
 */
export function normalizeMarketTimeOrder(
  order: MarketTimeOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || order.vendorName;
  const warnings = [...order.warnings];

  // A quote is not an order. Importing one would raise a draft PO for
  // something nobody has placed, so it is the first thing the buyer sees.
  if (order.holdNote) {
    warnings.push(
      `This document is marked as a quote or on hold ("${order.holdNote}") — it may not be a ` +
        "placed order. Check before importing.",
    );
  }

  const rows: HomeAccessoryExportRow[] = order.items.map((item) => ({
    ...baseRow(),
    // Bare vendor item number — the page re-keys it with the vendor record's
    // Vendor.code, same as the K&K and Wendover rows.
    partNumber: item.itemNumber,
    styleNumber: item.itemNumber,
    productName: item.name,
    qty: item.qty,
    // Taken as printed: this vendor's Price column IS the unit price.
    cost: item.unitPrice,
    supplier: vendorName,
    // Real 12-digit manufacturer UPCs, unlike K&K and Wendover.
    barcode: item.upc,
    reference: order.poNumber,
  }));

  return {
    vendorName,
    customerPo: order.poNumber,
    orderDate: order.orderDate,
    orders: [
      {
        orderNumber: order.poNumber,
        requiredDate: order.shipDate,
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings,
  };
}

/**
 * A BrandWise (Zodax) order as export rows. No UPC column and no sets: cost
 * is the unit price as printed, barcode stays blank.
 */
export function normalizeBrandWiseOrder(
  order: BrandWiseOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || "Zodax";
  const rows: HomeAccessoryExportRow[] = order.items.map((item) => ({
    ...baseRow(),
    partNumber: item.sku,
    styleNumber: item.sku,
    productName: item.name,
    qty: item.qty,
    cost: item.unitPrice,
    supplier: vendorName,
    // No UPC on the document.
    barcode: "",
    reference: order.poNumber,
  }));

  return {
    vendorName,
    customerPo: order.poNumber,
    orderDate: order.orderDate,
    orders: [
      {
        orderNumber: order.poNumber || order.salesOrderNo,
        requiredDate: order.shipDate,
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings: [...order.warnings],
  };
}

/**
 * An Aesthetic Movement (Printworks) order as export rows. The Price column
 * is the unit price already (verified in FC: qty x price == total on
 * PON09056's 6 lines), so cost is taken as printed. A UPC is the
 * manufacturer's when present and blank for an out-of-stock item that
 * prints none.
 */
export function normalizeAestheticMovementOrder(
  order: AestheticMovementOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || order.vendorName;
  const rows: HomeAccessoryExportRow[] = order.items.map((item) => ({
    ...baseRow(),
    // Bare vendor SKU -- the page re-keys it with the vendor record's
    // Vendor.code, same as the other formats.
    partNumber: item.sku,
    styleNumber: item.sku,
    productName: item.name,
    qty: item.qty,
    // Taken as printed: this vendor's Price column IS the unit price.
    cost: item.unitPrice,
    supplier: vendorName,
    // Manufacturer UPC when present; blank for an OOS item that prints none.
    barcode: item.upc,
    reference: order.poNumber,
  }));

  return {
    vendorName,
    customerPo: order.poNumber,
    orderDate: order.shipDate,
    orders: [
      {
        orderNumber: order.poNumber,
        requiredDate: order.shipDate,
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings: [...order.warnings],
  };
}

/**
 * A SuperCatSolutions (Jamie Young) order as export rows. The Price column
 * is the unit price already (verified in FC: qty x price == extension on
 * all 20 lines of Ref 153642), so cost is taken as printed. No UPC column,
 * so barcodes stay blank. An order-level discount is NOT applied to the
 * unit costs automatically -- it is surfaced as a warning.
 */
export function normalizeSuperCatOrder(
  order: SuperCatOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || order.vendorName;
  const rows: HomeAccessoryExportRow[] = order.items.map((item) => ({
    ...baseRow(),
    // Bare vendor item number -- the page re-keys it with the vendor record's
    // Vendor.code, same as the other formats.
    partNumber: item.itemNumber,
    styleNumber: item.itemNumber,
    productName: item.name,
    qty: item.qty,
    // Taken as printed: this vendor's Price column IS the unit price.
    cost: item.unitPrice,
    supplier: vendorName,
    // No UPC on the document.
    barcode: "",
    reference: order.orderNumber,
  }));

  return {
    vendorName,
    customerPo: order.customerPo,
    orderDate: order.orderDate,
    orders: [
      {
        orderNumber: order.orderNumber,
        requiredDate: order.shipDate,
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings: [...order.warnings],
  };
}

/**
 * A Simblist Group (Maison Zoe Ford) CSV order as export rows. The Unit
 * Price is the cost as printed (verified in FC: qty x Unit Price == Total
 * Price on every line), the UPC is the manufacturer's 14-digit case code,
 * and the ship note is carried into the description so the buyer sees any
 * "only available to ship on" caveat. An order-level discount is NOT
 * applied to the unit costs automatically -- it is surfaced as a warning.
 */
export function normalizeSimblistOrder(
  order: SimblistOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || order.vendorName;
  const rows: HomeAccessoryExportRow[] = order.items.map((item) => ({
    ...baseRow(),
    // Bare vendor item number -- the page re-keys it with the vendor record's
    // Vendor.code, same as the other formats.
    partNumber: item.itemNumber,
    styleNumber: item.itemNumber,
    productName: item.name,
    qty: item.qty,
    // Taken as printed: the Unit Price column IS the (case) cost.
    cost: item.unitPrice,
    supplier: vendorName,
    // Real manufacturer UPC (14-digit case code) from the CSV.
    barcode: item.upc,
    // The ship caveat, when present, rides along in the description.
    description: item.notes,
    reference: order.poNumber,
  }));

  return {
    vendorName,
    customerPo: order.poNumber,
    orderDate: order.orderDate,
    orders: [
      {
        orderNumber: order.poNumber,
        requiredDate: order.shipDate,
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings: [...order.warnings],
  };
}

/**
 * A Beatriz Ball order as export rows. Cost is the wholesale UNIT price,
 * and because this vendor prints a real MSRP, both the row's MSRP and its
 * selling price prefill from it (a $0 line like the free placard leaves
 * them blank so the markup prefill and buyer decide). No UPC column, so
 * barcodes stay blank.
 */
export function normalizeBeatrizBallOrder(
  order: BeatrizBallOrder,
  format?: HomeAccessoryFormat,
): HomeAccessoryDraft {
  const vendorName = format?.catalogVendorName || order.vendorName;
  const rows: HomeAccessoryExportRow[] = order.items.map((item) => {
    const retail = item.msrp > 0 ? item.msrp : null;
    return {
      ...baseRow(),
      // Bare vendor item code -- the page re-keys it with the vendor record's
      // Vendor.code, same as the other formats.
      partNumber: item.itemCode,
      styleNumber: item.itemCode,
      productName: item.name,
      qty: item.qty,
      // Wholesale unit price as printed.
      cost: item.unitPrice,
      // Real MSRP prefills both retail fields (editable per row).
      msrp: retail,
      selling: retail,
      supplier: vendorName,
      // No UPC on the document.
      barcode: "",
      reference: order.customerPo,
    };
  });

  return {
    vendorName,
    customerPo: order.customerPo,
    orderDate: order.orderDate,
    orders: [
      {
        orderNumber: order.customerPo || order.orderNumber,
        requiredDate: "",
        itemCount: order.items.length,
      },
    ],
    rows,
    warnings: [...order.warnings],
  };
}
