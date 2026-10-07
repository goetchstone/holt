// /app/src/lib/pricing/parsePriceBook.ts
//
// One entry point for "turn this price-book PDF into rows": the vendor/type
// dispatch that used to live inside the parse-pdf route, with the route's
// three silent failure modes closed.
//
// What was silent, and is not now:
//
//   1. An unknown vendor fell through to the Wesley Hall parser. The form's
//      `vendor` field defaulted to "wesley-hall", so a store with a Century book
//      got Wesley Hall's row shapes applied to it and a count of 0.
//      -> `UnsupportedVendorError`, and the route answers 400 with the list.
//   2. A known vendor with a book type its parser does not handle left the
//      rows array untouched -- `cr-laine` + `foundations`, say -- and reported
//      success with count 0.
//      -> `UnsupportedTypeError`, 400.
//   3. A parse that produced nothing reported `success: true, count: 0`, and the
//      UI rendered that as a green toast. The registry engine now explains its
//      own zeros (columnGrid.ts); every legacy parser that returns an empty
//      set gets an `error` diagnostic attached here, because none of the eight
//      throws on a mismatched book.
//      -> `count === 0` always carries at least one error diagnostic, and the
//         route answers 422.
//
// The route stays a route (upload, call, status). The coverage script calls
// this function directly against a directory of PDFs, so what CI measures and
// what a user sees are the same code path.

import type { ParseDiagnostic, ParseSummary } from "./pricingTypes";
import { extractWholesaleGrid } from "./wholesale/columnGrid";
import { supportedWholesaleVendorIds, wholesaleProfileFor } from "./wholesale/registry";
import { extractWholesalePricing, extractFabricCatalog } from "./pdfTableExtractor";
import { parseWholesaleRows, parseFoundationsRows } from "./wesleyHallParser";
import { parseSEPricing } from "./seParser";
import { extractCrLaineWholesale, extractCrLaineSimplicity } from "./crLaineExtractor";
import { extractGatCreekPricing } from "./gatCreekExtractor";
import { parseKingsleyBatePriceList } from "./kingsleyBateParser";

/**
 * Vendors read by a hand-written parser rather than a registry profile. Each
 * has a distinct layout; the list is the set of `vendor` values the dispatch
 * below accepts. Adding a vendor here is the OLD way -- prefer a profile in
 * `wholesale/vendors/` when the book is a column grid.
 */
export const LEGACY_VENDOR_IDS = [
  "wesley-hall",
  "brown-jordan",
  "kingsley-bate",
  "summer-classics",
  "jensen-leisure",
  "ekornes",
  "american-leather",
  "caperton",
  "gat-creek",
  "c-r-laine",
  "cr-laine",
] as const;

/** Every `vendor` value `parsePriceBook` will accept, registry and legacy, sorted. */
export function supportedPriceBookVendorIds(): string[] {
  return [...new Set([...supportedWholesaleVendorIds(), ...LEGACY_VENDOR_IDS])].sort();
}

export function isSupportedPriceBookVendor(vendor: string): boolean {
  return supportedPriceBookVendorIds().includes(vendor);
}

export class UnsupportedVendorError extends Error {
  readonly supported: string[];
  constructor(vendor: string) {
    const supported = supportedPriceBookVendorIds();
    super(
      vendor
        ? `No price-book reader for vendor "${vendor}". Supported: ${supported.join(", ")}`
        : `A vendor is required. Supported: ${supported.join(", ")}`,
    );
    this.name = "UnsupportedVendorError";
    this.supported = supported;
  }
}

export class UnsupportedTypeError extends Error {
  constructor(vendor: string, type: string, accepted: readonly string[]) {
    super(
      `Vendor "${vendor}" has no reader for book type "${type}". Accepted: ${accepted.join(", ")}`,
    );
    this.name = "UnsupportedTypeError";
  }
}

/** What the route returns and the coverage script records. */
export interface PriceBookParse {
  vendor: string;
  /** The effective type -- American Leather flips to retail-prices when the book is the retail copy. */
  type: string;
  count: number;
  /** An array of rows, or the vendor's own shape (Brown Jordan, Kingsley Bate, ...). The UI knows which by vendor. */
  data: unknown;
  diagnostics: ParseDiagnostic[];
  summary?: ParseSummary;
  meta?: Record<string, unknown>;
}

/**
 * Every zero comes with a reason. A legacy parser that returns nothing gets
 * this generic one; the registry engine writes its own, more specific one.
 */
export function finalizeParse(parse: PriceBookParse): PriceBookParse {
  if (parse.count > 0) return parse;
  const hasError = parse.diagnostics.some((d) => d.level === "error");
  if (hasError) return parse;
  return {
    ...parse,
    diagnostics: [
      ...parse.diagnostics,
      {
        level: "error",
        message:
          `the ${parse.vendor} reader produced no rows from this file: wrong book, a new edition ` +
          `whose layout this reader does not know, or a spreadsheet-only vendor given a PDF`,
      },
    ],
  };
}

/** True when the parse must be refused: nothing usable, or an edition/marker check failed. */
export function parseIsRefused(parse: PriceBookParse): boolean {
  return parse.count === 0 || parse.diagnostics.some((d) => d.level === "error");
}

export async function parsePriceBook(
  buffer: Buffer,
  vendor: string,
  type: string,
): Promise<PriceBookParse> {
  if (!vendor || !isSupportedPriceBookVendor(vendor)) {
    throw new UnsupportedVendorError(vendor);
  }

  // Registry first. Vendors on the shared column-transposed grid declare
  // themselves in `lib/pricing/wholesale/vendors/`, so adding one is a profile
  // module and a registry line -- not another branch here.
  const gridProfile = wholesaleProfileFor(vendor);
  if (gridProfile) {
    if (type !== "wholesale") throw new UnsupportedTypeError(vendor, type, ["wholesale"]);
    const result = await extractWholesaleGrid(buffer, gridProfile);
    return finalizeParse({
      vendor,
      type: "wholesale",
      count: result.data.length,
      data: result.data,
      diagnostics: result.diagnostics,
      summary: result.summary,
      meta: { vendorLabel: gridProfile.label, stats: result.stats },
    });
  }

  // The pre-registry vendors, each with its own distinct layout.
  switch (vendor) {
    case "brown-jordan": {
      const { parseBrownJordanPriceList } = await import("./brownJordanParser");
      const d = await parseBrownJordanPriceList(buffer);
      const count = d.seating.length + d.tables.length + d.fabrics.length + d.finishes.length;
      return finalizeParse({ vendor, type: "retail-prices", count, data: d, diagnostics: [] });
    }
    case "kingsley-bate": {
      const d = await parseKingsleyBatePriceList(buffer);
      const count = d.frames.length + d.cushions.length + d.covers.length + d.fabrics.length;
      return finalizeParse({ vendor, type: "retail-prices", count, data: d, diagnostics: [] });
    }
    case "summer-classics": {
      const { parseSummerClassicsWholesale } = await import("./summerClassicsParser");
      const d = await parseSummerClassicsWholesale(buffer);
      return finalizeParse({
        vendor,
        type: "wholesale",
        count: d.products.length,
        data: d,
        diagnostics: [],
      });
    }
    case "jensen-leisure": {
      const { parseJensenLeisureWholesale } = await import("./jensenLeisureParser");
      const d = await parseJensenLeisureWholesale(buffer);
      return finalizeParse({
        vendor,
        type: "wholesale",
        count: d.products.length,
        data: d,
        diagnostics: [],
      });
    }
    case "ekornes": {
      const { parseEkornesPriceList } = await import("./ekornesParser");
      const d = await parseEkornesPriceList(buffer);
      return finalizeParse({
        vendor,
        type: "retail-prices",
        count: d.products.length,
        data: d,
        diagnostics: [],
      });
    }
    case "american-leather": {
      const { extractAmericanLeather } = await import("./americanLeatherExtractor");
      const d = await extractAmericanLeather(buffer);
      const collections = [...new Set(d.products.map((p) => p.collectionName))];
      return finalizeParse({
        vendor,
        type: d.isRetail ? "retail-prices" : "wholesale",
        count: d.products.length,
        data: {
          products: d.products,
          pages: d.pages,
          collections,
          effectiveDate: d.effectiveDate,
          isRetail: d.isRetail,
        },
        diagnostics: [],
      });
    }
    case "caperton":
    case "gat-creek": {
      const rows = await extractGatCreekPricing(buffer);
      return finalizeParse({ vendor, type, count: rows.length, data: rows, diagnostics: [] });
    }
    case "c-r-laine":
    case "cr-laine": {
      if (type === "wholesale") {
        const rows = await extractCrLaineWholesale(buffer);
        return finalizeParse({ vendor, type, count: rows.length, data: rows, diagnostics: [] });
      }
      if (type === "simplicity") {
        const rows = await extractCrLaineSimplicity(buffer);
        return finalizeParse({ vendor, type, count: rows.length, data: rows, diagnostics: [] });
      }
      throw new UnsupportedTypeError(vendor, type, ["wholesale", "simplicity"]);
    }
    case "wesley-hall": {
      if (type === "wholesale" || type === "foundations") {
        const rawRows = await extractWholesalePricing(buffer);
        const r =
          type === "wholesale" ? parseWholesaleRows(rawRows) : parseFoundationsRows(rawRows);
        return finalizeParse({
          vendor,
          type,
          count: r.data.length,
          data: r.data,
          diagnostics: r.diagnostics,
          summary: r.summary,
        });
      }
      if (type === "fabrics") {
        const rows = await extractFabricCatalog(buffer);
        return finalizeParse({ vendor, type, count: rows.length, data: rows, diagnostics: [] });
      }
      if (type === "signature-elements") {
        const rows = await parseSEPricing(buffer);
        return finalizeParse({ vendor, type, count: rows.length, data: rows, diagnostics: [] });
      }
      throw new UnsupportedTypeError(vendor, type, [
        "wholesale",
        "foundations",
        "fabrics",
        "signature-elements",
      ]);
    }
    default:
      // Unreachable: isSupportedPriceBookVendor guards the switch. Kept so a
      // vendor added to LEGACY_VENDOR_IDS without a case fails loudly.
      throw new UnsupportedVendorError(vendor);
  }
}
