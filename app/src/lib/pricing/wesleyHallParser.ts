// /app/src/lib/pricing/wesleyHallParser.ts
//
// Normalizes raw rows (from PDF extraction or CSV/XLSX upload)
// into structured product records ready for database import.

import { parseCurrency } from "./pricingUtils";
import { ParseResult, ParseDiagnostic, createEmptyParseResult } from "./pricingTypes";
import { getErrorMessage } from "@/lib/toastError";

// ─── Parsed output types ────────────────────────────────────────────

export interface ParsedWholesaleProduct {
  styleNumber: string;
  description: string;
  styleName: string;
  leatherStyleNumber: string | null;
  finish: string | null;
  decorativeFinishSurcharge: number | null;
  standardPillows: string | null;
  gradeRiser: number | null;
  standardSeat: string | null;
  standardBack: string | null;
  springDownBdbSurcharge: number | null;
  comfortDownBdbSurcharge: number | null;
  yardagePlain: number | null;
  yardagePattern: number | null;
  yardageRepeat: number | null;
  // "isStandard" flags — true means option is included at no extra charge
  springDownBdbIsStandard?: boolean;
  comfortDownBdbIsStandard?: boolean;
  decorativeFinishIsStandard?: boolean;
  nailheadSurcharge?: number | null;
  nailheadIsStandard?: boolean;
  armGuardSurcharge?: number | null;
  armGuardIsStandard?: boolean;
  ringBaseSwivelSurcharge?: number | null;
  ringBaseSwivelIsStandard?: boolean;
  castorSurcharge?: number | null;
  castorIsStandard?: boolean;
  cdcSeatBdbBackSurcharge?: number | null;
  cdcSeatBdbBackIsStandard?: boolean;
  harmonySurcharge?: number | null;
  harmonyIsStandard?: boolean;
  contrastWeltSurcharge?: number | null;
  contrastWeltIsStandard?: boolean;
  contrastBiasWeltSurcharge?: number | null;
  contrastBiasWeltIsStandard?: boolean;
  fiberBackSurcharge?: number | null;
  fiberBackIsStandard?: boolean;
  comfortDownBackSurcharge?: number | null;
  comfortDownBackIsStandard?: boolean;
  legacyDownBackSurcharge?: number | null;
  legacyDownBackIsStandard?: boolean;
  extraFullBackSurcharge?: number | null;
  extraFullBackIsStandard?: boolean;
  gradePrices: { grade: string; cost: number }[];
  // Physical dimensions (from price list line drawings)
  overallWidth: number | null;
  overallDepth: number | null;
  overallHeight: number | null;
  seatHeight: number | null;
  armHeight: number | null;
  seatDepth: number | null;
  // Physical PDF page number (1-based) for image-to-style mapping
  pageNumber: number;
}

export interface ParsedFoundationsProduct {
  styleNumber: string;
  description: string;
  styleName: string;
  foundationsCost: number;
  standardSeat: string | null;
  standardBack: string | null;
  springDownSeatSurcharge: number | null;
  cdcSeatBdbBackSurcharge: number | null;
  decorativeFinishSurcharge: number | null;
  ringBaseSwivel: number | null;
  nailheadTrim: string | null;
  // "isStandard" flags — true means option is included at no extra charge
  springDownSeatIsStandard?: boolean;
  cdcSeatBdbBackIsStandard?: boolean;
  decorativeFinishIsStandard?: boolean;
  nailheadSurcharge?: number | null;
  nailheadIsStandard?: boolean;
}

export interface ParsedDecorativeTreatment {
  groupName: string;
  options: {
    name: string;
    surcharge: number;
    surchargeType: "FLAT" | "PER_UNIT";
  }[];
}

export interface ParsedFabricRow {
  fabricName: string;
  fabricCode?: string | null;
  colorName: string;
  grade: string;
  currentAvailable?: number | null;
  onOrder?: number | null;
  expectedArrival?: string | null;
}

// ─── Wholesale parser ───────────────────────────────────────────────

/**
 * Remap CSV/XLSX row keys using COLUMN_ALIASES so fields like "Width" or "W"
 * become "overallWidth". Only remaps if the rows appear to come from CSV (i.e.,
 * keys are raw header strings rather than camelCase from the PDF extractor).
 */
function remapRowHeaders(rows: Record<string, any>[]): Record<string, any>[] {
  if (rows.length === 0) return rows;

  const headers = Object.keys(rows[0]);

  // Skip remapping if the rows already have camelCase keys from the PDF extractor
  if (headers.includes("styleNumber") || headers.includes("gradePrices")) {
    return rows;
  }

  const { mapping } = detectColumns(headers);
  if (Object.keys(mapping).length === 0) return rows;

  // Build a reverse map: original header → semantic field name
  const headerToField = new Map<string, string>();
  for (const [field, header] of Object.entries(mapping)) {
    headerToField.set(header, field);
  }

  return rows.map((row) => {
    const remapped: Record<string, any> = { ...row };
    for (const [header, field] of headerToField) {
      if (row[header] !== undefined && remapped[field] === undefined) {
        remapped[field] = row[header];
      }
    }
    return remapped;
  });
}

/**
 * Parse raw wholesale rows (from PDF extractor or CSV) into structured products.
 * Accepts either the WholesaleRawRow format from pdfTableExtractor,
 * or a generic Record<string, string> from CSV/XLSX parsing.
 *
 * For CSV/XLSX rows, applies column alias detection to remap headers like
 * "Width" → "overallWidth" so dimension and other fields are found regardless
 * of the exact header name used in the source file.
 */
export function parseWholesaleRows(
  rows: Record<string, any>[],
): ParseResult<ParsedWholesaleProduct> {
  const result = createEmptyParseResult<ParsedWholesaleProduct>();
  const remappedRows = remapRowHeaders(rows);
  result.summary.totalRowsProcessed = remappedRows.length;

  for (let i = 0; i < remappedRows.length; i++) {
    const row = remappedRows[i];
    try {
      const styleNumber = row.styleNumber || row["Style #"] || row["Style Number"] || "";
      const description = row.description || row["Description"] || "";
      const styleName = row.styleName || row["Style Name"] || "";

      if (!styleNumber) {
        result.diagnostics.push({
          level: "warning",
          row: i + 1,
          field: "styleNumber",
          message: "Missing style number, row skipped",
        });
        result.summary.skippedCount++;
        continue;
      }

      const gradePrices: { grade: string; cost: number }[] = [];

      if (row.gradePrices && typeof row.gradePrices === "object") {
        for (const [grade, val] of Object.entries(row.gradePrices)) {
          const cost = parseCurrency(String(val));
          if (!isNaN(cost) && cost > 0) {
            gradePrices.push({ grade, cost });
          } else if (val && String(val).trim() !== "") {
            result.diagnostics.push({
              level: "warning",
              row: i + 1,
              field: grade,
              message: `Unparseable grade price "${String(val)}" for grade ${grade}`,
            });
          }
        }
      } else {
        const fabricGrades = [
          "COM",
          "14",
          "15",
          "16",
          "17",
          "18",
          "19",
          "20",
          "21",
          "22",
          "23",
          "24",
          "25",
          "26",
          "27",
          "28",
          "29",
          "30",
          "31",
          "32",
          "33",
          "34",
          "35",
        ];
        const leatherGrades = [
          "COL",
          "C",
          "D",
          "E",
          "F",
          "G",
          "H",
          "I",
          "J",
          "K",
          "L",
          "M",
          "N",
          "O",
          "P",
          "Q",
          "R",
          "S",
          "T",
          "U",
          "V",
          "W",
          "X",
          "Y",
          "Z",
        ];
        const gradeKeys = [...fabricGrades, ...leatherGrades];
        for (const g of gradeKeys) {
          const val = row[g] || row[`Grade ${g}`] || row[`GRADE${g}`];
          if (val) {
            const cost = parseCurrency(String(val));
            if (!isNaN(cost) && cost > 0) {
              gradePrices.push({ grade: g, cost });
            }
          }
        }
      }

      if (gradePrices.length === 0) {
        result.diagnostics.push({
          level: "warning",
          row: i + 1,
          field: "gradePrices",
          message: `No valid grade prices for style ${styleNumber}`,
        });
        result.summary.skippedCount++;
        continue;
      }

      const gradeRiserStr = row.gradeRiser || row["Grade Riser"] || "";
      const yardageStr = row.yardagePlain || row['Ydg. Req. 54" Plain'] || row["Yardage"] || "";
      const yardagePatternStr = row.yardagePattern || row['Ydg. Req. 54" Pattern'] || "";
      const yardageRepeatStr = row.yardageRepeat || row['Ydg. Req. 54" Repeat'] || "";

      const decorativeFinish = parseOptionValue(
        row.decorativeFinish || row["Decorative Finish"] || "",
      );
      const springDown = parseOptionValue(row.springDownBdb || row["Spring-Down/BDB"] || "");
      const comfortDown = parseOptionValue(row.comfortDownBdb || row["Comfort Down/BDB"] || "");
      const nailhead = parseOptionValue(
        row.availableNailTrim ||
          row["AVAILABLE NAIL TRIM"] ||
          row["Nailhead Trim"] ||
          row["Nail Trim"] ||
          "",
      );
      const armGuard = parseOptionValue(row.armGuards || row["Arm Guards"] || "");
      const ringBase = parseOptionValue(row.ringBaseSwivel || row["Ring Base Swivel"] || "");
      const castors = parseOptionValue(row.castors || row["Castors"] || "");
      const cdcSeat = parseOptionValue(row.cdcSeatBdbBack || row["CDC Seat/BDB Back"] || "");

      result.data.push({
        styleNumber: String(styleNumber).trim(),
        description: String(description).trim(),
        styleName: String(styleName).trim(),
        leatherStyleNumber: nullIfNA(row.leatherStyleNumber || row["Leather Style #"]),
        finish: nullIfNA(row.finish || row["Finish"]),
        decorativeFinishSurcharge: decorativeFinish.surcharge,
        decorativeFinishIsStandard: decorativeFinish.isStandard,
        standardPillows: nullIfNA(row.standardPillows || row["Standard Pillows"]),
        gradeRiser: parseOptionalNumber(gradeRiserStr),
        standardSeat: nullIfNA(row.standardSeat || row["Standard Seat"] || row["STANDARD SEAT"]),
        standardBack: nullIfNA(row.standardBack || row["Standard Back"] || row["STANDARD BACK"]),
        springDownBdbSurcharge: springDown.surcharge,
        springDownBdbIsStandard: springDown.isStandard,
        comfortDownBdbSurcharge: comfortDown.surcharge,
        comfortDownBdbIsStandard: comfortDown.isStandard,
        yardagePlain: parseOptionalNumber(yardageStr),
        yardagePattern: parseOptionalNumber(yardagePatternStr),
        yardageRepeat: parseOptionalNumber(yardageRepeatStr),
        nailheadSurcharge: nailhead.surcharge,
        nailheadIsStandard: nailhead.isStandard,
        armGuardSurcharge: armGuard.surcharge,
        armGuardIsStandard: armGuard.isStandard,
        ringBaseSwivelSurcharge: ringBase.surcharge,
        ringBaseSwivelIsStandard: ringBase.isStandard,
        castorSurcharge: castors.surcharge,
        castorIsStandard: castors.isStandard,
        cdcSeatBdbBackSurcharge: cdcSeat.surcharge,
        cdcSeatBdbBackIsStandard: cdcSeat.isStandard,
        gradePrices,
        overallWidth: parseOptionalNumber(row.overallWidth || row["Overall Width"]),
        overallDepth: parseOptionalNumber(row.overallDepth || row["Overall Depth"]),
        overallHeight: parseOptionalNumber(row.overallHeight || row["Overall Height"]),
        seatHeight: parseOptionalNumber(row.seatHeight || row["Seat Height"]),
        armHeight: parseOptionalNumber(row.armHeight || row["Arm Height"]),
        seatDepth: parseOptionalNumber(row.seatDepth || row["Seat Depth"]),
        pageNumber: row.pageNumber || 0,
      });
      result.summary.successCount++;
    } catch (err: unknown) {
      result.diagnostics.push({
        level: "error",
        row: i + 1,
        message: `Row parse failed: ${getErrorMessage(err, "unknown error")}`,
      });
      result.summary.skippedCount++;
    }
  }

  result.summary.warningCount = result.diagnostics.filter((d) => d.level === "warning").length;
  result.summary.errorCount = result.diagnostics.filter((d) => d.level === "error").length;
  return result;
}

// ─── Column detection for CSV/XLSX ──────────────────────────────────

export interface ColumnMapping {
  [semanticField: string]: string; // semantic field → actual CSV column header
}

const COLUMN_ALIASES: Record<string, string[]> = {
  styleNumber: ["Style #", "Style", "Style No", "Item #", "Item", "Style Number", "STYLE NUMBER"],
  description: ["Description", "Desc", "Item Description", "DESCRIPTION"],
  styleName: ["Style Name", "Name", "Pattern", "STYLE NAME"],
  leatherStyleNumber: ["Leather Style #", "Leather Style", "L Style", "Leather Style Number"],
  finish: ["Finish", "Wood Finish"],
  decorativeFinish: ["Decorative Finish", "Dec Finish", "Deco Finish"],
  standardPillows: ["Standard Pillows", "Std Pillows", "Pillows"],
  gradeRiser: ["Grade Riser", "Riser", "Grade Rise", "GRADE RISER"],
  standardSeat: ["Standard Seat", "Std Seat", "Seat", "STANDARD SEAT"],
  standardBack: ["Standard Back", "Std Back", "Back", "STANDARD BACK"],
  comYardage: ["COM Yds", "Yardage", "COM Yardage", 'Ydg. Req. 54" Plain'],
  comYardagePattern: [
    "COM Yds Pattern",
    "Yardage Pattern",
    "COM Yardage Pattern",
    'Ydg. Req. 54" Pattern',
  ],
  comYardageRepeat: [
    "COM Yds Repeat",
    "Yardage Repeat",
    "COM Yardage Repeat",
    'Ydg. Req. 54" Repeat',
  ],
  overallWidth: ["Overall Width", "Width", "W"],
  overallDepth: ["Overall Depth", "Depth", "D"],
  overallHeight: ["Overall Height", "Height", "H", "Overall Ht"],
  seatHeight: ["Seat Height", "Seat Ht", "SH"],
  armHeight: ["Arm Height", "Arm Ht", "AH"],
  seatDepth: ["Seat Depth", "SD"],
};

/**
 * Auto-detect column mappings from CSV headers.
 * Returns a mapping of semantic field names to actual column headers.
 */
export function detectColumns(headers: string[]): {
  mapping: ColumnMapping;
  gradeColumns: string[];
  unmapped: string[];
} {
  const mapping: ColumnMapping = {};
  const gradeColumns: string[] = [];
  const mappedHeaders = new Set<string>();

  // 1. Match semantic fields by alias
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const found = headers.find((h) => h.toLowerCase().trim() === alias.toLowerCase().trim());
      if (found) {
        mapping[field] = found;
        mappedHeaders.add(found);
        break;
      }
    }
  }

  // 2. Detect grade columns (numeric: "14", "COM", leather: "COL", "C", "D", etc.)
  for (const header of headers) {
    const trimmed = header.trim();
    if (mappedHeaders.has(trimmed)) continue;

    // Check if it's a grade column
    if (trimmed === "COM" || trimmed === "(COM)" || trimmed === "COL" || trimmed === "(COL)") {
      gradeColumns.push(trimmed);
      mappedHeaders.add(trimmed);
    } else if (/^\d{1,2}$/.test(trimmed)) {
      // "7", "14", "15", etc.
      gradeColumns.push(trimmed);
      mappedHeaders.add(trimmed);
    } else if (/^Grade\s*\d{1,2}$/i.test(trimmed)) {
      // "Grade 7", "Grade 14"
      gradeColumns.push(trimmed);
      mappedHeaders.add(trimmed);
    } else if (/^GRADE\d{1,2}$/i.test(trimmed)) {
      // "GRADE7", "GRADE14"
      gradeColumns.push(trimmed);
      mappedHeaders.add(trimmed);
    } else if (/^[A-Z]$/.test(trimmed) && trimmed >= "C" && trimmed <= "Z") {
      // Single letter leather grade: "C", "D", ..., "Z"
      gradeColumns.push(trimmed);
      mappedHeaders.add(trimmed);
    }
  }

  // 3. Identify unmapped columns
  const unmapped = headers.filter((h) => !mappedHeaders.has(h));

  return { mapping, gradeColumns, unmapped };
}

// ─── Foundations parser ──────────────────────────────────────────────

export function parseFoundationsRows(
  rows: Record<string, any>[],
): ParseResult<ParsedFoundationsProduct> {
  const result = createEmptyParseResult<ParsedFoundationsProduct>();
  result.summary.totalRowsProcessed = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const styleNumber = row["Style #"] || row["Style Number"] || row.styleNumber || "";
      const cost = parseCurrency(
        String(row["Foundations Cost"] || row["Cost"] || row.foundationsCost || "0"),
      );

      if (!styleNumber) {
        result.diagnostics.push({
          level: "warning",
          row: i + 1,
          field: "styleNumber",
          message: "Missing style number, row skipped",
        });
        result.summary.skippedCount++;
        continue;
      }

      if (isNaN(cost) || cost <= 0) {
        result.diagnostics.push({
          level: "warning",
          row: i + 1,
          field: "foundationsCost",
          message: `Invalid cost for style ${styleNumber}`,
        });
        result.summary.skippedCount++;
        continue;
      }

      const springDown = parseOptionValue(
        row["Spring-Down Seat"] ||
          row.springDownSeat ||
          row["Spring-Down/BDB"] ||
          row.springDownBdb ||
          "",
      );
      const cdcSeat = parseOptionValue(row["CDC Seat/BDB Back"] || row.cdcSeatBdbBack || "");
      const decorativeFinish = parseOptionValue(
        row["Decorative Finish"] || row.decorativeFinish || "",
      );
      const ringBase = parseOptionValue(row["Ring Base Swivel"] || row.ringBaseSwivel || "");
      const nailhead = parseOptionValue(
        row["Nailhead Trim"] || row["Nail Trim"] || row.nailheadTrim || row.availableNailTrim || "",
      );

      result.data.push({
        styleNumber: String(styleNumber).trim(),
        description: String(row["Description"] || row.description || "").trim(),
        styleName: String(row["Style Name"] || row.styleName || "").trim(),
        foundationsCost: cost,
        standardSeat: nullIfNA(row["Standard Seat"] || row["STANDARD SEAT"] || row.standardSeat),
        standardBack: nullIfNA(row["Standard Back"] || row["STANDARD BACK"] || row.standardBack),
        springDownSeatSurcharge: springDown.surcharge,
        springDownSeatIsStandard: springDown.isStandard,
        cdcSeatBdbBackSurcharge: cdcSeat.surcharge,
        cdcSeatBdbBackIsStandard: cdcSeat.isStandard,
        decorativeFinishSurcharge: decorativeFinish.surcharge,
        decorativeFinishIsStandard: decorativeFinish.isStandard,
        ringBaseSwivel: ringBase.surcharge,
        nailheadTrim: nullIfNA(
          row["Nailhead Trim"] || row["Nail Trim"] || row.nailheadTrim || row.availableNailTrim,
        ),
        nailheadSurcharge: nailhead.surcharge,
        nailheadIsStandard: nailhead.isStandard,
      });
      result.summary.successCount++;
    } catch (err: unknown) {
      result.diagnostics.push({
        level: "error",
        row: i + 1,
        message: `Row parse failed: ${getErrorMessage(err, "unknown error")}`,
      });
      result.summary.skippedCount++;
    }
  }

  result.summary.warningCount = result.diagnostics.filter((d) => d.level === "warning").length;
  result.summary.errorCount = result.diagnostics.filter((d) => d.level === "error").length;
  return result;
}

// ─── Fabric catalog parser ────────────────────────────────────────────

/**
 * Parse rows from a Wesley Hall fabric list (CSV/XLSX or PDF-extracted)
 * into structured fabric rows ready for the fabric import API.
 *
 * Handles flexible column naming and deduplicates by fabricName+colorName.
 */
export function parseFabricRows(rows: Record<string, any>[]): ParseResult<ParsedFabricRow> {
  const result = createEmptyParseResult<ParsedFabricRow>();
  if (rows.length === 0) return result;

  result.summary.totalRowsProcessed = rows.length;

  const headers = Object.keys(rows[0]);
  const findCol = (aliases: string[]): string | null => {
    for (const alias of aliases) {
      const found = headers.find((h) => h.toLowerCase().trim() === alias.toLowerCase().trim());
      if (found) return found;
    }
    return null;
  };

  const fabricNameCol = findCol([
    "Fabric Pattern",
    "Pattern",
    "fabricName",
    "Fabric Name",
    "FABRIC PATTERN",
    "fabric_pattern",
  ]);
  const colorNameCol = findCol([
    "Fabric Color",
    "Color",
    "colorName",
    "Color Name",
    "FABRIC COLOR",
    "fabric_color",
  ]);
  const gradeCol = findCol(["Grade", "Fabric Grade", "grade", "GRADE", "fabric_grade", "Tier"]);
  const fabricCodeCol = findCol(["Swatch #", "Swatch", "fabricCode", "Fabric Code", "SKU"]);
  const availableCol = findCol([
    "Current Available",
    "Available",
    "Qty Available",
    "In Stock",
    "current_available",
  ]);
  const onOrderCol = findCol(["On Order", "Total On Order", "Ordered", "on_order"]);
  const arrivalCol = findCol([
    "Expected Arrival Date",
    "Arrival Date",
    "ETA",
    "Expected",
    "expected_arrival",
  ]);
  const activeCol = findCol(["Active/Inactive", "Status", "Active"]);

  if (!fabricNameCol || !gradeCol) {
    result.diagnostics.push({
      level: "error",
      message: `Required columns not found. Need "Fabric Pattern" (or alias) and "Grade" (or alias). Found: ${headers.join(", ")}`,
    });
    result.summary.errorCount = 1;
    return result;
  }

  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const fabricName = String(row[fabricNameCol] || "").trim();
      const grade = String(row[gradeCol] || "").trim();
      if (!fabricName || !grade) {
        result.summary.skippedCount++;
        continue;
      }

      if (activeCol) {
        const status = String(row[activeCol] || "")
          .trim()
          .toUpperCase();
        if (status === "I" || status === "INACTIVE") {
          result.summary.skippedCount++;
          continue;
        }
      }

      const colorName = colorNameCol ? String(row[colorNameCol] || "").trim() : "";
      const dedupeKey = `${fabricName}|||${colorName}`.toLowerCase();

      if (seen.has(dedupeKey)) {
        result.summary.skippedCount++;
        continue;
      }
      seen.add(dedupeKey);

      const fabricCode = fabricCodeCol ? String(row[fabricCodeCol] || "").trim() || null : null;
      const available = availableCol ? Number.parseFloat(String(row[availableCol] || "")) : null;
      const onOrder = onOrderCol ? Number.parseFloat(String(row[onOrderCol] || "")) : null;
      const arrival = arrivalCol ? String(row[arrivalCol] || "").trim() || null : null;

      result.data.push({
        fabricName,
        fabricCode,
        colorName,
        grade,
        currentAvailable: available && !isNaN(available) ? available : null,
        onOrder: onOrder && !isNaN(onOrder) ? onOrder : null,
        expectedArrival: arrival,
      });
      result.summary.successCount++;
    } catch (err: unknown) {
      result.diagnostics.push({
        level: "error",
        row: i + 1,
        message: `Row parse failed: ${getErrorMessage(err, "unknown error")}`,
      });
      result.summary.skippedCount++;
    }
  }

  result.summary.warningCount = result.diagnostics.filter((d) => d.level === "warning").length;
  result.summary.errorCount = result.diagnostics.filter((d) => d.level === "error").length;
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────

function nullIfNA(val: any): string | null {
  if (!val) return null;
  const s = String(val).trim();
  if (s === "N/A" || s === "N/C" || s === "-" || s === "") return null;
  return s;
}

function parseOptionalNumber(val: any): number | null {
  if (!val) return null;
  const num = parseCurrency(String(val));
  return isNaN(num) ? null : num;
}

/**
 * Parse an option value that may be "Std" (standard/included at no extra charge),
 * a dollar amount (surcharge), or empty/dash/N/A (not available).
 */
interface OptionParseResult {
  surcharge: number | null;
  isStandard: boolean;
}

function parseOptionValue(val: any): OptionParseResult {
  if (!val) return { surcharge: null, isStandard: false };
  const s = String(val).trim();
  if (!s) return { surcharge: null, isStandard: false };

  // Standard/included: option is built-in, no choice needed, no charge
  if (/^(std\.?|standard|included|incl\.?|inc\.?|[\u2713\u2714\u221A])$/i.test(s)) {
    return { surcharge: 0, isStandard: true };
  }

  // No Charge: option is available at $0, but user must choose it
  if (/^(n\/c|nc|no\s*charge)$/i.test(s)) {
    return { surcharge: 0, isStandard: false };
  }

  // Not available markers: N/A, NA, hyphen, double-hyphen, en-dash, em-dash
  if (/^(n\/a|na|[-\u2013\u2014]{1,2})$/i.test(s)) {
    return { surcharge: null, isStandard: false };
  }

  // Dollar amount (surcharge)
  const num = parseCurrency(s);
  return isNaN(num)
    ? { surcharge: null, isStandard: false }
    : { surcharge: num, isStandard: false };
}

// ─── Signature Elements types ─────────────────────────────────────────────────
//
// The parser itself lives in seParser.ts (server-only, requires pdf-parse).
// The interface is exported here so client-side code can reference the type
// without pulling in Node-only dependencies.

export interface ParsedSEProduct {
  styleNumber: string;
  styleName: string;
  description: string;
  material: "FABRIC" | "LEATHER";
  depthCode: string;
  pieceTypeCode: string;
  gradePrices: { grade: string; cost: number }[];
  gradeRiser: number | null;
  decorativeFinishSurcharge: number;
  standardSeat: string | null;
  standardBack: string | null;
  comfortDownTightBack: number | null;
  comfortDownFilledBack: number | null;
  springDownTightBack: number | null;
  springDownFilledBack: number | null;
}
