// /app/src/lib/pricing/standardPriceBook.ts
//
// Holt's STANDARD PRICE-BOOK LAYOUT: one spreadsheet shape any vendor's
// wholesale book can be put into, so a vendor with no parser of its own (a
// new client's line, the demo's mock vendors) imports through the same route
// as the ones that have one (pages/api/pricing/import/wholesale-prices.ts).
//
// Client-safe: the price-book import screen parses with it, and so does the
// demo seed (prisma/seed/demo/priceBooks.ts). No server imports.
//
// The layout says what every column is, instead of the parser guessing:
//   - "Style #" (required), "Style Name", "Description";
//   - one column per grade, its material DECLARED in the header: "COM",
//     "COL", "Fabric <code>", "Leather <code>". A cell is that grade's COST;
//     blank or N/A means the style isn't offered in it. Guessing a grade's
//     material from its shape files a letter-laddered fabric book as leather
//     (lib/pricing/importWholesaleBook.ts partitionGrades), so this layout
//     never guesses;
//   - "COM Yardage", "Grade Riser", and dimensions in inches: "Width",
//     "Depth", "Height", "Seat Height", "Arm Height", "Seat Depth";
//   - one column per option, "Option: <Group> / <Name>", whose cell is Std
//     (comes with it), N/C (no charge, but a choice), a price, N/A (not
//     offered on this style), or blank (not mentioned).
// Any other column is reported and ignored, never silently dropped.

import Papa from "papaparse";
import {
  createEmptyParseResult,
  type ParseDiagnostic,
  type ParseResult,
} from "@/lib/pricing/pricingTypes";

type Material = "FABRIC" | "LEATHER";

export interface StandardBookOption {
  groupName: string;
  optionName: string;
  surcharge: number;
  surchargeType: "FLAT";
  isStandard: boolean;
  isAvailable: boolean;
  requiresTextInput: boolean;
  textInputLabel: string | null;
  sortOrder: number;
}

/** One style, in the wholesale import's body shape (wholesaleProductSchema). */
export interface StandardBookProduct {
  styleNumber: string;
  styleName: string;
  description: string;
  gradePrices: { grade: string; cost: number; material: Material }[];
  yardagePlain?: number | null;
  gradeRiser?: number | null;
  overallWidth?: number | null;
  overallDepth?: number | null;
  overallHeight?: number | null;
  seatHeight?: number | null;
  armHeight?: number | null;
  seatDepth?: number | null;
  styleOptions?: StandardBookOption[];
}

type GradeColumn = { kind: "grade"; code: string; material: Material };
type OptionColumn = { kind: "option"; groupName: string; optionName: string; sortOrder: number };
type Column =
  | { kind: "styleNumber" | "styleName" | "description" }
  | GradeColumn
  | { kind: "number"; field: NumberField }
  | OptionColumn
  | { kind: "ignored" };

type NumberField =
  | "yardagePlain"
  | "gradeRiser"
  | "overallWidth"
  | "overallDepth"
  | "overallHeight"
  | "seatHeight"
  | "armHeight"
  | "seatDepth";

const NAMED: Record<string, Column> = {
  "style #": { kind: "styleNumber" },
  "style number": { kind: "styleNumber" },
  "style name": { kind: "styleName" },
  description: { kind: "description" },
  com: { kind: "grade", code: "COM", material: "FABRIC" },
  col: { kind: "grade", code: "COL", material: "LEATHER" },
  "com yardage": { kind: "number", field: "yardagePlain" },
  "grade riser": { kind: "number", field: "gradeRiser" },
  width: { kind: "number", field: "overallWidth" },
  depth: { kind: "number", field: "overallDepth" },
  height: { kind: "number", field: "overallHeight" },
  "seat height": { kind: "number", field: "seatHeight" },
  "arm height": { kind: "number", field: "armHeight" },
  "seat depth": { kind: "number", field: "seatDepth" },
};

// Bounded and anchored: a header is short, and a grade code is at most four
// characters ("L12", "P2").
const GRADE_HEADER = /^(fabric|leather) ([a-z0-9]{1,4})$/;
const OPTION_HEADER = /^option: ?([^/]{1,60}?) ?\/ ?(.{1,60})$/i;

function normalize(header: string): string {
  return header.trim().replace(/\s+/g, " ");
}

function classify(header: string, optionCount: number): Column {
  const h = normalize(header);
  const lower = h.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];
  const grade = GRADE_HEADER.exec(lower);
  if (grade) {
    return {
      kind: "grade",
      code: grade[2].toUpperCase(),
      material: grade[1] === "fabric" ? "FABRIC" : "LEATHER",
    };
  }
  const option = OPTION_HEADER.exec(h);
  if (option) {
    return {
      kind: "option",
      groupName: option[1].trim(),
      optionName: option[2].trim(),
      sortOrder: optionCount,
    };
  }
  return { kind: "ignored" };
}

/** A money or measure cell: "$1,250.00", "1250", "14 1/2" is not accepted. */
function readNumber(cell: string): number | null {
  const n = Number(cell.replace(/[$,\s]/g, ""));
  return cell.trim() !== "" && Number.isFinite(n) ? n : null;
}

const NOT_OFFERED = new Set(["n/a", "na", "--", "-"]);
const STANDARD = new Set(["std", "standard", "included"]);
const NO_CHARGE = new Set(["n/c", "nc", "no charge"]);

type OptionCell =
  | { kind: "none" }
  | { kind: "option"; surcharge: number; isStandard: boolean; isAvailable: boolean }
  | { kind: "unreadable" };

function readOptionCell(cell: string): OptionCell {
  const v = cell.trim().toLowerCase();
  if (v === "") return { kind: "none" };
  if (NOT_OFFERED.has(v))
    return { kind: "option", surcharge: 0, isStandard: false, isAvailable: false };
  if (STANDARD.has(v)) return { kind: "option", surcharge: 0, isStandard: true, isAvailable: true };
  if (NO_CHARGE.has(v))
    return { kind: "option", surcharge: 0, isStandard: false, isAvailable: true };
  const price = readNumber(cell);
  if (price !== null && price >= 0) {
    return { kind: "option", surcharge: price, isStandard: false, isAvailable: true };
  }
  return { kind: "unreadable" };
}

function readColumns(headers: string[], diagnostics: ParseDiagnostic[]): Map<string, Column> {
  const columns = new Map<string, Column>();
  const gradeMaterial = new Map<string, Material>();
  let optionCount = 0;
  for (const header of headers) {
    const column = classify(header, optionCount);
    if (column.kind === "option") optionCount++;
    if (column.kind === "ignored" && header.trim() !== "") {
      diagnostics.push({
        level: "warning",
        field: header,
        message: `Column "${header}" isn't part of the standard layout, so it was ignored.`,
      });
    }
    if (column.kind === "grade") {
      const seen = gradeMaterial.get(column.code);
      if (seen && seen !== column.material) {
        diagnostics.push({
          level: "error",
          field: header,
          message: `Grade "${column.code}" is declared as both fabric and leather. Give one of them another code.`,
        });
        columns.set(header, { kind: "ignored" });
        continue;
      }
      gradeMaterial.set(column.code, column.material);
    }
    columns.set(header, column);
  }
  return columns;
}

function cellOf(row: Record<string, unknown>, header: string): string {
  const value = row[header];
  return value == null ? "" : String(value).trim();
}

/** Where one row's cells land, and how a cell it can't read is reported. */
interface RowSink {
  product: StandardBookProduct;
  options: StandardBookOption[];
  warn: (field: string, message: string) => void;
}

function readGradeCell(cell: string, header: string, column: GradeColumn, sink: RowSink) {
  if (cell === "" || NOT_OFFERED.has(cell.toLowerCase())) return;
  const cost = readNumber(cell);
  if (cost !== null && cost > 0) {
    sink.product.gradePrices.push({ grade: column.code, cost, material: column.material });
  } else {
    sink.warn(header, `"${cell}" isn't a cost, so ${header} was left out for this style.`);
  }
}

function readNumberCell(cell: string, header: string, field: NumberField, sink: RowSink) {
  if (cell === "") return;
  const n = readNumber(cell);
  if (n !== null) sink.product[field] = n;
  else sink.warn(header, `"${cell}" isn't a number, so ${header} was left out.`);
}

function readOptionColumn(cell: string, header: string, column: OptionColumn, sink: RowSink) {
  const read = readOptionCell(cell);
  if (read.kind === "unreadable") {
    sink.warn(header, `"${cell}" isn't Std, N/C, N/A or a price, so ${header} was left out.`);
  } else if (read.kind === "option") {
    sink.options.push({
      groupName: column.groupName,
      optionName: column.optionName,
      surcharge: read.surcharge,
      surchargeType: "FLAT",
      isStandard: read.isStandard,
      isAvailable: read.isAvailable,
      requiresTextInput: false,
      textInputLabel: null,
      sortOrder: column.sortOrder,
    });
  }
}

function readCell(cell: string, header: string, column: Column, sink: RowSink) {
  switch (column.kind) {
    case "styleNumber":
    case "styleName":
    case "description":
      sink.product[column.kind] = cell;
      return;
    case "grade":
      return readGradeCell(cell, header, column, sink);
    case "number":
      return readNumberCell(cell, header, column.field, sink);
    case "option":
      return readOptionColumn(cell, header, column, sink);
    case "ignored":
      return;
  }
}

/** One row as a style, or null when the row is skipped (the reason is logged). */
function readRow(
  row: Record<string, unknown>,
  rowNumber: number,
  columns: Map<string, Column>,
  diagnostics: ParseDiagnostic[],
): StandardBookProduct | null {
  const sink: RowSink = {
    product: { styleNumber: "", styleName: "", description: "", gradePrices: [] },
    options: [],
    warn: (field, message) =>
      diagnostics.push({ level: "warning", row: rowNumber, field, message }),
  };
  for (const [header, column] of columns) readCell(cellOf(row, header), header, column, sink);
  const { product, options } = sink;
  if (!product.styleNumber) {
    diagnostics.push({
      level: "warning",
      row: rowNumber,
      message: "No style number, so the row was skipped.",
    });
    return null;
  }
  if (product.gradePrices.length === 0) {
    diagnostics.push({
      level: "warning",
      row: rowNumber,
      field: product.styleNumber,
      message: `Style ${product.styleNumber} has no grade cost, so it was skipped.`,
    });
    return null;
  }
  if (options.length > 0) product.styleOptions = options;
  return product;
}

/** Parse rows (header -> cell, as Papa or SheetJS give them) in the standard layout. */
export function parseStandardPriceBookRows(
  rows: Record<string, unknown>[],
): ParseResult<StandardBookProduct> {
  const result = createEmptyParseResult<StandardBookProduct>();
  result.summary.totalRowsProcessed = rows.length;
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const columns = readColumns(headers, result.diagnostics);
  if (![...columns.values()].some((c) => c.kind === "styleNumber")) {
    result.diagnostics.push({
      level: "error",
      message: 'No "Style #" column, so this isn\'t a standard-layout price book.',
    });
  } else {
    rows.forEach((row, i) => {
      const product = readRow(row, i + 2, columns, result.diagnostics);
      if (product) result.data.push(product);
      else result.summary.skippedCount++;
    });
  }
  result.summary.successCount = result.data.length;
  result.summary.warningCount = result.diagnostics.filter((d) => d.level === "warning").length;
  result.summary.errorCount = result.diagnostics.filter((d) => d.level === "error").length;
  return result;
}

/** Parse a standard-layout CSV's text (the demo seed reads its books this way). */
export function parseStandardPriceBookCsv(text: string): ParseResult<StandardBookProduct> {
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
  return parseStandardPriceBookRows(parsed.data);
}

/** The template a store downloads to put a vendor's book into the layout. */
export const STANDARD_TEMPLATE_HEADERS = [
  "Style #",
  "Style Name",
  "Description",
  "COM",
  "Fabric 10",
  "Fabric 12",
  "Leather C",
  "Leather D",
  "COM Yardage",
  "Grade Riser",
  "Width",
  "Depth",
  "Height",
  "Option: Nailhead / Antique Brass",
  "Option: Skirt / Kick Pleat",
] as const;

export function standardTemplateCsv(): string {
  return Papa.unparse({
    fields: [...STANDARD_TEMPLATE_HEADERS],
    data: [
      [
        "1001-S",
        "Example Sofa",
        "Sofa",
        "980",
        "1040",
        "1110",
        "1850",
        "1990",
        "14",
        "40",
        "84",
        "38",
        "34",
        "Std",
        "75",
      ],
      [
        "1001-C",
        "Example Chair",
        "Chair",
        "560",
        "600",
        "640",
        "",
        "",
        "6.5",
        "20",
        "34",
        "36",
        "34",
        "N/A",
        "N/C",
      ],
    ],
  });
}
