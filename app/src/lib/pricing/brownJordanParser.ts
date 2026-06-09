// /app/src/lib/pricing/brownJordanParser.ts
//
// Server-side PDF parser for Brown Jordan retail price lists.
//
// Brown Jordan is an outdoor furniture vendor using the GRADE_BASED pricing
// model. The PDF contains retail prices organized by collection, with:
//   - Cushioned seating: fabric grades A-H (8 tiers)
//   - Sling seating: grades A-C (3 tiers)
//   - Tables: flat MSRP (no grades)
//   - Fabric catalog: fabric name + grade assignment
//
// Cost = retail * 0.44 (computed during import, not during parsing).
//
// This file uses pdf-parse and must only be imported from API routes
// (never from client-side code).

import { extractPdfTextWithPages } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";

// ─── Exported types ──────────────────────────────────────────────

export interface ParsedBJSeating {
  styleNumber: string;
  description: string;
  collection: string;
  dimensions: string | null;
  gradePrices: { grade: string; retail: number }[];
  comRetail: number | null;
  pageNumber: number;
}

export interface ParsedBJTable {
  styleNumber: string;
  description: string;
  collection: string;
  msrp: number;
  tableTop: string | null;
  pageNumber: number;
}

export interface ParsedBJFabric {
  fabricNumber: string;
  fabricName: string;
  grade: string;
  fabricType: string;
}

export interface ParsedBJFinish {
  finishName: string;
  finishCode: string | null;
}

export interface ParsedBJData {
  seating: ParsedBJSeating[];
  tables: ParsedBJTable[];
  fabrics: ParsedBJFabric[];
  finishes: ParsedBJFinish[];
}

// ─── Helpers ─────────────────────────────────────────────────────

const GRADE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

// Sanity cap: no BJ product retails above $100k. Values exceeding this
// indicate a PDF extraction error (e.g., adjacent price cells merged due
// to inline images shifting column positions).
const MAX_RETAIL_PRICE = 100_000;

/** BJ product numbers: 4 digits, dash, 4 digits, optional finish suffix. */
const PRODUCT_NUM_RE = /^\d{4}-\d{4}(-?[A-Z]{1,3})?$/;

/** Matches a clean product number at the start of a tab-separated line. */
function extractProductNumber(field: string): string | null {
  const cleaned = field.replace(/[*†§¶‡Δ▲◆●○\s]/g, "").trim();
  if (!cleaned) return null;
  if (PRODUCT_NUM_RE.test(cleaned)) return cleaned;
  // Handle product numbers with dash-separated suffix (e.g., 5900-1000-SL)
  const match = cleaned.match(/^(\d{4}-\d{4}(?:-[A-Z]{1,3})?)$/);
  return match ? match[1] : null;
}

/** Strip "TABLES" suffix from collection name for grouping. */
function normalizeCollectionName(raw: string): string {
  return raw
    .replace(/\s+TABLES?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect whether a line is a BJ collection/section header.
 * BJ headers are all-caps bold text (e.g., "CALCUTTA", "FLIGHT SLING",
 * "CALCUTTA TABLES", "FARO"). They may include designer credit on the
 * next line but the header itself is a standalone all-caps line.
 */
const NON_COLLECTION_HEADERS = new Set([
  "BROWN JORDAN",
  "PRODUCT",
  "FRAME",
  "DESCRIPTION",
  "MSRP",
  "GRADE",
  "FABRIC",
  "NUMBER",
  "MOQ",
  "CARE AND MAINTENANCE INSTRUCTIONS",
  "WARRANTY: RESIDENTIAL",
  "WARRANTY: CONTRACT / HOSPITALITY",
  "TEAK FURNITURE OWNERSHIP GUIDE",
  "PAINT FINISH AND FABRIC CHART",
  "AND STRAP COLORS",
  "FABRIC ATTRIBUTES AND CHARACTERISTICS",
  "YARDAGE REQUIREMENTS",
  "COM NOTIFICATION FORM",
  "SUGGESTED TABLE & CHAIR COMBINATIONS",
  "FREIGHT",
  "SHOWROOMS",
  "2026 SUGGESTED RETAIL PRICE LIST",
  "TABLE OF CONTENTS",
]);

// Section headers that should be treated as pseudo-collections. Products under
// these sections get attributed to the section name rather than the preceding
// real collection (e.g., "Replacement Cushions" instead of "Calcutta").
const PSEUDO_COLLECTION_MAP: Record<string, string> = {
  "REPLACEMENT CUSHIONS": "Replacement Cushions",
  "REPLACEMENT SLINGS": "Replacement Slings",
  "PILLOW INFORMATION": "Pillows",
  WELTING: "Welting",
  "MISCELLANEOUS PARTS": "Miscellaneous Parts",
};

function isCollectionHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 2) return null;

  // Must be all-caps (allow spaces, ampersands, parentheses, periods)
  if (!/^[A-Z][A-Z\s&'().\/0-9]+$/.test(trimmed)) return null;

  // Skip known non-collection headers
  const upper = trimmed.toUpperCase();
  if (NON_COLLECTION_HEADERS.has(upper)) return null;

  // Skip lines that look like column headers or data
  if (/^(PRODUCT|ITEM|FRAME|UNIT|PIECES|CARTON)\b/i.test(trimmed)) return null;

  // Skip single-word lines that are likely sub-headers or labels
  if (/^(DESIGN|UPDATED|CAST|EXTRUDED|WOVEN|CUSHIONS|SLINGS)\b/.test(trimmed)) return null;

  // Skip lines containing pricing data
  if (/\$/.test(trimmed)) return null;

  // Min length to avoid noise
  if (trimmed.length < 3) return null;

  return trimmed;
}

/** Detect if a line contains grade column headers. */
function detectGradeColumns(line: string): string[] | null {
  const fields = line.split("\t").map((f) => f.trim());
  const grades: string[] = [];

  for (const field of fields) {
    // Match "Grade A", "Grade B", etc. (from multi-row headers where "Grade" and "A" are merged)
    const gradeMatch = field.match(/^Grade\s+([A-H])$/i);
    if (gradeMatch) {
      grades.push(gradeMatch[1].toUpperCase());
      continue;
    }
    // Match standalone letters A-H in header context
    if (/^[A-H]$/.test(field) && grades.length > 0) {
      grades.push(field);
    }
  }

  return grades.length >= 2 ? grades : null;
}

/** Detect if a line is a column header row (contains "MSRP" or "Grade"). */
function isHeaderRow(line: string): boolean {
  const upper = line.toUpperCase();
  return (
    (upper.includes("GRADE") && /GRADE\s+[A-H]/i.test(upper)) ||
    (upper.includes("MSRP") && upper.includes("PRODUCT")) ||
    (upper.includes("PRODUCT") && upper.includes("NUMBER") && upper.includes("DESCRIPTION"))
  );
}

/** Parse BJ dimension strings like "W 24.25 . D 25.75 . H 35.75 . SH 20 . AH 25.5 . SD 19" */
function parseBJDimensions(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[•·]/g, ".").trim();
  if (/W\s*[\d.]+/i.test(cleaned)) return cleaned;
  return null;
}

// ─── Section type detection ──────────────────────────────────────

type SectionType = "graded" | "msrp" | "unknown";

interface ColumnLayout {
  type: SectionType;
  gradeIndices: Map<string, number>; // grade letter → tab index
  msrpIndex: number;
  topIndex: number;
  descriptionIndex: number;
  comIndex: number;
  fabricYdgIndex: number;
}

/**
 * Analyze header rows to determine column layout.
 * BJ headers often span two rows:
 *   Row 1: "Product\tFrame\tDescription\t\tGrade\tGrade\t..."
 *   Row 2: "Number\t\t\t\tA\tB\t..."
 * Or sometimes on one row:
 *   "Product Number\tFrame\tDescription\tMSRP\tTop\t..."
 */
function detectColumnLayout(headerLines: string[]): ColumnLayout {
  const layout: ColumnLayout = {
    type: "unknown",
    gradeIndices: new Map(),
    msrpIndex: -1,
    topIndex: -1,
    descriptionIndex: -1,
    comIndex: -1,
    fabricYdgIndex: -1,
  };

  // Merge all header lines into one combined field map
  const allFields: string[][] = headerLines.map((l) => l.split("\t").map((f) => f.trim()));

  // Look for MSRP column
  for (const fields of allFields) {
    for (let i = 0; i < fields.length; i++) {
      if (/^MSRP$/i.test(fields[i])) {
        layout.msrpIndex = i;
        layout.type = "msrp";
      }
      if (/^Top$/i.test(fields[i])) {
        layout.topIndex = i;
      }
      if (/^Description$/i.test(fields[i])) {
        layout.descriptionIndex = i;
      }
    }
  }

  // Look for grade columns: "Grade A", "Grade B", etc.
  // These might be split across two rows: "Grade" on row 1, "A" on row 2
  for (const fields of allFields) {
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];

      // Direct match: "Grade A" through "Grade H"
      const directMatch = field.match(/^Grade\s+([A-H])$/i);
      if (directMatch) {
        layout.gradeIndices.set(directMatch[1].toUpperCase(), i);
        layout.type = "graded";
        continue;
      }

      // Standalone letter in a position that follows "Grade" labels
      if (/^[A-H]$/.test(field) && layout.gradeIndices.size > 0) {
        layout.gradeIndices.set(field, i);
      }

      // SRP(A) through SRP(H) format (seen in pillow section)
      const srpMatch = field.match(/^SRP\s*\(([A-H])\)$/i);
      if (srpMatch) {
        layout.gradeIndices.set(srpMatch[1].toUpperCase(), i);
        layout.type = "graded";
      }

      if (/^COM$/i.test(field)) {
        layout.comIndex = i;
      }
      if (/^Fabric\s+Ydg/i.test(field)) {
        layout.fabricYdgIndex = i;
      }
    }
  }

  // If no explicit Grade labels found, check for MSRP followed by standalone
  // letters in the second header row
  if (layout.gradeIndices.size === 0 && allFields.length >= 2) {
    const row2 = allFields[allFields.length - 1];
    let foundGrade = false;
    for (let i = 0; i < row2.length; i++) {
      if (/^[A-H]$/.test(row2[i])) {
        layout.gradeIndices.set(row2[i], i);
        foundGrade = true;
      }
    }
    if (foundGrade && layout.gradeIndices.size >= 2) {
      layout.type = "graded";
    }
  }

  // If we found grade columns but also MSRP, it's a graded section
  // (MSRP column shows the Grade A price in some layouts)
  if (layout.gradeIndices.size >= 2) {
    layout.type = "graded";
  }

  return layout;
}

// ─── Main parser ─────────────────────────────────────────────────

export async function parseBrownJordanPriceList(pdfBuffer: Buffer): Promise<ParsedBJData> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);
  const lines = rawText.split("\n");

  const seating: ParsedBJSeating[] = [];
  const tables: ParsedBJTable[] = [];

  let currentCollection = "";
  let currentPage = 0;
  let layout: ColumnLayout | null = null;
  let headerBuffer: string[] = [];
  let inNonProductSection = false;

  // Sections we skip entirely (warranty, care, freight, etc.)
  const SKIP_SECTIONS = new Set([
    "CARE AND MAINTENANCE INSTRUCTIONS",
    "TEAK FURNITURE OWNERSHIP GUIDE",
    "WARRANTY: RESIDENTIAL",
    "WARRANTY: CONTRACT / HOSPITALITY",
    "FREIGHT",
    "SHOWROOMS",
    "COM NOTIFICATION FORM",
    "YARDAGE REQUIREMENTS",
    "SUGGESTED TABLE & CHAIR COMBINATIONS",
    "PAINT FINISH AND FABRIC CHART",
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pageMatch = trimmed.match(/^<<PAGE:(\d+)>>$/);
    if (pageMatch) {
      currentPage = Number.parseInt(pageMatch[1], 10);
      continue;
    }

    // Pseudo-collection sections (replacement cushions, slings, pillows, etc.)
    // get their own collection name so products aren't mis-attributed to the
    // preceding real collection.
    const normUpper = collapseWhitespace(trimmed).toUpperCase();
    const pseudoColl = PSEUDO_COLLECTION_MAP[normUpper];
    if (pseudoColl) {
      currentCollection = pseudoColl;
      inNonProductSection = false;
      layout = null;
      headerBuffer = [];
      continue;
    }

    // Detect collection headers first so they can exit skip-section mode.
    // Without this, once a non-product section is entered (e.g., "YARDAGE
    // REQUIREMENTS"), every subsequent collection in the PDF is dropped.
    const collHeader = isCollectionHeader(trimmed);
    if (collHeader) {
      currentCollection = normalizeCollectionName(collHeader);
      inNonProductSection = false;
      layout = null;
      headerBuffer = [];
      continue;
    }

    // Check for non-product sections to skip. Normalize tabs to spaces
    // because the column-aware PDF renderer inserts tabs between text items.
    if (SKIP_SECTIONS.has(collapseWhitespace(trimmed).toUpperCase())) {
      inNonProductSection = true;
      layout = null;
      continue;
    }
    if (inNonProductSection) continue;

    // Detect column header rows
    if (isHeaderRow(line)) {
      headerBuffer = [line];
      // Check if the next line is a continuation of the header
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
      if (
        nextLine &&
        !extractProductNumber(nextLine.split("\t")[0]?.trim() || "") &&
        !isCollectionHeader(nextLine)
      ) {
        // Could be second header row (e.g., "Number\t\t\tA\tB\tC...")
        if (/^(Number|#|\s)/.test(nextLine) || /^[A-H]\t/.test(nextLine)) {
          headerBuffer.push(lines[i + 1]);
          i++; // Skip the consumed line
        }
      }
      layout = detectColumnLayout(headerBuffer);
      continue;
    }

    // Skip lines without a valid layout or collection
    if (!layout || !currentCollection) continue;

    // Parse data rows
    const fields = line.split("\t");
    const productNum = extractProductNumber(fields[0]?.trim() || "");
    if (!productNum) continue;

    if (layout.type === "graded") {
      const product = parseGradedProduct(
        fields,
        productNum,
        currentCollection,
        layout,
        lines,
        i,
        currentPage,
      );
      if (product) seating.push(product);
    } else if (layout.type === "msrp") {
      const table = parseTableProduct(fields, productNum, currentCollection, layout, currentPage);
      if (table) tables.push(table);
    }
  }

  // Parse fabric and finish catalogs in separate passes (own section markers)
  const fabrics = parseFabricLines(lines);
  const finishes = parsePaintFinishes(lines);

  return { seating, tables, fabrics, finishes };
}

// ─── Product row parsers ─────────────────────────────────────────

function parseGradedProduct(
  fields: string[],
  styleNumber: string,
  collection: string,
  layout: ColumnLayout,
  allLines: string[],
  lineIndex: number,
  pageNumber: number,
): ParsedBJSeating | null {
  // Extract description (usually field index 2, after Product Number and Frame)
  const descIndex = layout.descriptionIndex >= 0 ? layout.descriptionIndex : 2;
  let description = fields[descIndex]?.trim() || "";

  // Check for multi-line description on the next line
  if (lineIndex + 1 < allLines.length) {
    const nextLine = allLines[lineIndex + 1]?.trim() || "";
    if (
      nextLine &&
      !extractProductNumber(nextLine.split("\t")[0]?.trim() || "") &&
      !isCollectionHeader(nextLine) &&
      !isHeaderRow(nextLine)
    ) {
      const nextFields = allLines[lineIndex + 1].split("\t");
      // If the next line's first field is empty or whitespace and has dimension-like content
      const continuation = nextFields.find((f) => f.trim() && /[WDH]\s*[\d.]+/i.test(f.trim()));
      if (continuation) {
        description += " " + continuation.trim();
      }
    }
  }

  // Extract dimensions from description
  const dimMatch = description.match(/W\s*[\d.]+[^$]*/i);
  const dimensions = dimMatch ? dimMatch[0].trim() : null;

  // Clean description: remove dimension part
  const cleanDesc = description
    .replace(/\s*W\s*[\d.]+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Extract grade prices
  const gradePrices: { grade: string; retail: number }[] = [];
  for (const [grade, idx] of layout.gradeIndices) {
    if (idx >= fields.length) continue;
    const val = parseCurrency(fields[idx] || "");
    if (!isNaN(val) && val > 0 && val <= MAX_RETAIL_PRICE) {
      gradePrices.push({ grade, retail: val });
    }
  }

  // MSRP column often holds the Grade A price for graded products
  if (layout.msrpIndex >= 0 && gradePrices.length === 0) {
    const msrpVal = parseCurrency(fields[layout.msrpIndex] || "");
    if (!isNaN(msrpVal) && msrpVal > 0) {
      // Single MSRP with no grade breakdown: treat as flat-priced
      return null;
    }
  }

  if (gradePrices.length === 0) return null;

  // Sort grade prices by letter
  gradePrices.sort((a, b) => a.grade.localeCompare(b.grade));

  // COM price
  let comRetail: number | null = null;
  if (layout.comIndex >= 0 && layout.comIndex < fields.length) {
    const comVal = parseCurrency(fields[layout.comIndex] || "");
    if (!isNaN(comVal) && comVal > 0 && comVal <= MAX_RETAIL_PRICE) {
      comRetail = comVal;
    }
  }

  return {
    styleNumber,
    description: cleanDesc || description,
    collection,
    dimensions,
    gradePrices,
    comRetail,
    pageNumber,
  };
}

function parseTableProduct(
  fields: string[],
  styleNumber: string,
  collection: string,
  layout: ColumnLayout,
  pageNumber: number,
): ParsedBJTable | null {
  const descIndex = layout.descriptionIndex >= 0 ? layout.descriptionIndex : 2;
  const description = fields[descIndex]?.trim() || "";

  const msrpVal = layout.msrpIndex >= 0 ? parseCurrency(fields[layout.msrpIndex] || "") : NaN;
  if (isNaN(msrpVal) || msrpVal <= 0 || msrpVal > MAX_RETAIL_PRICE) return null;

  const tableTop = layout.topIndex >= 0 ? fields[layout.topIndex]?.trim() || null : null;

  return {
    styleNumber,
    description: description.replace(/\s+/g, " ").trim(),
    collection,
    msrp: msrpVal,
    tableTop: tableTop === "-" ? null : tableTop,
    pageNumber,
  };
}

// ─── Fabric & strap catalog parser ──────────────────────────────

const FABRIC_TYPE_HEADERS: Record<string, string> = {
  "SOLID SUNCLOTH FABRIC": "Solid Suncloth",
  "PATTERNED SUNCLOTH FABRIC": "Patterned Suncloth",
  "STRIPED SUNCLOTH FABRIC": "Striped Suncloth",
  "VERSATEX MESH": "Versatex Mesh",
  "FURNITURE COVER FABRIC": "Furniture Cover",
};

// Collapse tabs (from column-aware PDF extraction) into single spaces
// so section header comparisons work regardless of layout spacing.
function collapseWhitespace(s: string): string {
  return s.replace(/[\t ]+/g, " ").trim();
}

function isFabricTypeHeader(normalized: string): string | null {
  for (const [header, type] of Object.entries(FABRIC_TYPE_HEADERS)) {
    if (normalized.startsWith(header)) return type;
  }
  return null;
}

function parseFabricLines(lines: string[]): ParsedBJFabric[] {
  const fabrics: ParsedBJFabric[] = [];
  let currentType = "";
  let inFabricSection = false;
  let inStrapSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<<PAGE:\d+>>$/.test(trimmed)) continue;

    // Normalize for header comparisons (tabs → spaces)
    const norm = collapseWhitespace(trimmed).toUpperCase();

    // Detect fabric section start. The PDF column renderer may insert tabs
    // in headings, so compare against normalized (tab-free) text.
    if (
      !inFabricSection &&
      !inStrapSection &&
      (norm === "FABRIC" ||
        norm === "FABRICS" ||
        norm.startsWith("FABRIC ATTRIBUTES") ||
        norm.startsWith("FABRIC CHART") ||
        norm === "PAINT FINISH AND FABRIC CHART" ||
        isFabricTypeHeader(norm) !== null)
    ) {
      inFabricSection = true;
      // If the line IS a type sub-header, set currentType immediately
      const typeMatch = isFabricTypeHeader(norm);
      if (typeMatch) {
        currentType = typeMatch;
      }
      continue;
    }

    // Detect strap section (follows fabrics in the combined chart)
    if (!inStrapSection && (norm.startsWith("STRAP COLOR") || norm.startsWith("AND STRAP COLOR"))) {
      inFabricSection = false;
      inStrapSection = true;
      currentType = "Strap";
      continue;
    }

    // End both sections at known non-fabric/strap headers
    if (
      (inFabricSection || inStrapSection) &&
      (norm.startsWith("SHOWROOM") ||
        norm.startsWith("WARRANTY") ||
        norm.startsWith("FREIGHT") ||
        norm.startsWith("MISCELLANEOUS") ||
        norm.startsWith("COM NOTIFICATION") ||
        norm.startsWith("CARE AND MAINTENANCE") ||
        norm.startsWith("SUGGESTED TABLE"))
    ) {
      break;
    }

    // When in fabric section, transition to straps on strap header
    if (inFabricSection && norm.startsWith("STRAP")) {
      inFabricSection = false;
      inStrapSection = true;
      currentType = "Strap";
      continue;
    }

    if (!inFabricSection && !inStrapSection) continue;

    // Detect fabric type sub-headers (only when in fabric section)
    if (inFabricSection) {
      const typeMatch = isFabricTypeHeader(norm);
      if (typeMatch) {
        currentType = typeMatch;
        continue;
      }
    }

    if (!currentType) continue;

    // Skip non-data lines (column headers, decorative)
    if (
      norm.startsWith("#") ||
      norm === "GRADE" ||
      norm.startsWith("NUMBER") ||
      norm === "COLOR" ||
      norm === "COLORS" ||
      norm.startsWith("---")
    ) {
      continue;
    }

    // Parse entries: "1294\tSailor\tB"  or  "WH\tWhite"
    const fields = line
      .split("\t")
      .map((f) => f.trim())
      .filter(Boolean);
    if (fields.length < 2) continue;

    const fabricNumber = fields[0];
    if (!/^[\dA-Z]{2,}$/i.test(fabricNumber)) continue;

    // Last non-empty field should be a grade letter (fabrics)
    // or may be absent (straps may not have grades)
    const lastField = fields[fields.length - 1];
    const grade = /^[A-H]$/i.test(lastField) ? lastField.toUpperCase() : null;

    // For fabrics, require a valid grade or N/A
    if (inFabricSection && !grade && lastField !== "N/A") continue;

    const nameFields = fields.slice(1, grade ? -1 : undefined);
    const fabricName = nameFields.join(" ").trim();
    if (!fabricName) continue;

    fabrics.push({
      fabricNumber,
      fabricName,
      grade: grade || "N/A",
      fabricType: currentType,
    });
  }

  return fabrics;
}

// ─── Paint finish parser ────────────────────────────────────────

function parsePaintFinishes(lines: string[]): ParsedBJFinish[] {
  const finishes: ParsedBJFinish[] = [];
  let inFinishSection = false;
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<<PAGE:\d+>>$/.test(trimmed)) continue;

    const norm = collapseWhitespace(trimmed).toUpperCase();

    // Detect finish section start
    if (
      !inFinishSection &&
      (norm === "PAINT FINISH AND FABRIC CHART" ||
        norm === "PAINT FINISHES" ||
        norm === "PAINT FINISH" ||
        norm.startsWith("FINISH CHART") ||
        norm.startsWith("STANDARD FINISHES") ||
        norm.startsWith("PAINT FINISH CHART"))
    ) {
      inFinishSection = true;
      continue;
    }

    // End finish section when we hit fabric/strap headers or other sections
    if (inFinishSection) {
      if (
        isFabricTypeHeader(norm) !== null ||
        norm === "FABRIC" ||
        norm === "FABRICS" ||
        norm.startsWith("FABRIC ATTRIBUTES") ||
        norm.startsWith("FABRIC CHART") ||
        norm.startsWith("STRAP COLOR") ||
        norm.startsWith("AND STRAP") ||
        norm.startsWith("SHOWROOM") ||
        norm.startsWith("WARRANTY") ||
        norm.startsWith("FREIGHT") ||
        norm.startsWith("MISCELLANEOUS")
      ) {
        break;
      }
    }

    if (!inFinishSection) continue;

    // Skip column headers and decorative lines
    if (
      norm === "FINISH" ||
      norm === "FINISHES" ||
      norm === "PAINT FINISH" ||
      norm === "COLOR" ||
      norm.startsWith("CODE") ||
      norm.startsWith("---") ||
      norm.length < 3
    ) {
      continue;
    }

    // Parse finish entries. Two common formats:
    // Tab-separated: "WH\tWhite"  or  "White\tWH"
    // Single name: "White" (no code)
    const fields = line
      .split("\t")
      .map((f) => f.trim())
      .filter(Boolean);

    if (fields.length === 0) continue;

    let finishName: string;
    let finishCode: string | null = null;

    if (fields.length >= 2) {
      // If first field is short (2-4 chars), treat as code
      if (fields[0].length <= 4 && /^[A-Z0-9]+$/i.test(fields[0])) {
        finishCode = fields[0].toUpperCase();
        finishName = fields.slice(1).join(" ").trim();
      } else if (
        fields[fields.length - 1].length <= 4 &&
        /^[A-Z0-9]+$/i.test(fields[fields.length - 1])
      ) {
        finishCode = fields[fields.length - 1].toUpperCase();
        finishName = fields.slice(0, -1).join(" ").trim();
      } else {
        finishName = fields.join(" ").trim();
      }
    } else {
      finishName = fields[0];
    }

    if (!finishName || finishName.length < 2) continue;

    // Deduplicate
    const key = finishName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    finishes.push({ finishName, finishCode });
  }

  return finishes;
}
