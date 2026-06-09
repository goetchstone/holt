// /app/src/lib/pricing/pdfTableExtractor.ts
//
// Server-side PDF table extractor for Wesley Hall price lists.
// Uses pdf-parse with a custom page renderer that preserves column
// positions (via X-coordinate gaps → tab separators), then parses
// each pricing grid into structured product rows.

import pdf from "pdf-parse";
import { columnAwarePageRenderer } from "./pdfUtils";
export { parseCurrency } from "./pricingUtils";

// ─── Types ────────────────────────────────────────────────────────

export interface WholesaleRawRow {
  styleNumber: string;
  description: string;
  styleName: string;
  leatherStyleNumber: string;
  finish: string;
  decorativeFinish: string;
  standardPillows: string;
  gradeRiser: string;
  standardSeat: string;
  standardBack: string;
  springDownBdb: string;
  comfortDownBdb: string;
  yardagePlain: string;
  yardagePattern: string;
  yardageRepeat: string;
  availableNailTrim: string;
  armGuards: string;
  gradePrices: Record<string, string>; // e.g. { "COM": "1200", "14": "1350" } or { "COL": "1730", "C": "1850" }
  // Physical dimensions (from price list line drawings)
  overallWidth: string;
  overallDepth: string;
  overallHeight: string;
  seatHeight: string;
  armHeight: string;
  seatDepth: string;
  // Foundations-specific fields (empty for wholesale imports)
  foundationsCost: string;
  cdcSeatBdbBack: string;
  ringBaseSwivel: string;
  castors: string;
  nailheadTrim: string;
  springDownSeat: string;
  // Physical PDF page number (1-based) for image-to-style mapping
  pageNumber: number;
}

// Grade labels for fabric pricing (numeric grades)
const FABRIC_GRADES = [
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

// Grade labels for leather pricing (letter grades)
const LEATHER_GRADES = [
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

const ALL_GRADE_CODES = new Set([...FABRIC_GRADES, ...LEATHER_GRADES]);

// ─── Main extraction entry point ──────────────────────────────────

/**
 * Extract wholesale pricing data from a Wesley Hall price list PDF.
 */
export async function extractWholesalePricing(pdfBuffer: Buffer): Promise<WholesaleRawRow[]> {
  const data = await pdf(pdfBuffer, {
    pagerender: columnAwarePageRenderer,
  });

  // columnAwarePageRenderer embeds <<PAGE:N>> markers with the physical page
  // number from pdfjs. Parse these instead of relying on array indices, which
  // break when blank/image-only pages shift the count.
  const pageMarkerRegex = /^<<PAGE:(\d+)>>\n/;
  const pageTexts = data.text.split("\f").filter((t) => t.trim());
  const allProducts: WholesaleRawRow[] = [];

  for (const pageText of pageTexts) {
    const marker = pageText.match(pageMarkerRegex);
    const physicalPage = marker ? Number.parseInt(marker[1], 10) : 0;
    const content = marker ? pageText.replace(pageMarkerRegex, "") : pageText;

    const pageChunks = splitIntoPages(content);
    for (const chunk of pageChunks) {
      const products = parsePageChunk(chunk);
      for (const p of products) {
        p.pageNumber = physicalPage;
      }
      allProducts.push(...products);
    }
  }

  return allProducts;
}

// ─── Split text into page-sized chunks ────────────────────────────

/**
 * Split the full PDF text into page-level chunks.
 * Each pricing page starts with "STYLE NUMBER" followed by tab-separated values.
 */
function splitIntoPages(text: string): string[] {
  const chunks: string[] = [];

  // Match "STYLE NUMBER" that's followed by a tab (indicating it's a header row
  // with data, not a reference in policy text like "Is the correct style number listed?")
  const regex = /^STYLE NUMBER\t/gm;
  const matches: number[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match.index);
  }

  // Also match "STYLE NUMBER" on its own line followed by values on subsequent
  // lines (some pages split label and values across lines)
  if (matches.length === 0) {
    const fallback = /^STYLE NUMBER$/gm;
    while ((match = fallback.exec(text)) !== null) {
      matches.push(match.index);
    }
  }

  for (let i = 0; i < matches.length; i++) {
    // Include content before the first "STYLE NUMBER" (dimension rows, headers)
    // that the column-aware renderer placed above the pricing table.
    const start = i === 0 ? 0 : matches[i];
    const end = i + 1 < matches.length ? matches[i + 1] : text.length;
    chunks.push(text.substring(start, end));
  }

  return chunks;
}

// ─── Parse a single pricing page ──────────────────────────────────

/**
 * Parse a single page chunk into product records.
 *
 * The column-aware renderer produces tab-separated lines like:
 *   STYLE NUMBER\t503\t504\t507\t...
 *   Chair\tChair\tChair\t...          ← DESCRIPTION values (on their own line)
 *   DESCRIPTION                        ← label alone (on next line)
 *   Lynford\tQuayden\tEarnest\t...    ← STYLE NAME values (on their own line)
 *   STYLE NAME                         ← label alone
 *   ...
 *   (COM)\t1285\t985\t925\t...
 *    GRADE\t14\t1309\t999\t937\t...   ← " GRADE\t14" = grade 14 header + prices
 *   15\t1321\t1006\t943\t...
 *   ...
 *   GRADE RISER\t12\t7\t6\t...
 */
function parsePageChunk(chunk: string): WholesaleRawRow[] {
  const lines = chunk.split("\n").map((l) => l.trimEnd());

  // ── Phase 1: Extract labeled rows ──
  const rowData: Record<string, string[]> = {};
  let numCols = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // ── STYLE NUMBER (always has values on the same line) ──
    if (line.startsWith("STYLE NUMBER\t")) {
      const vals = splitTabs(line, "STYLE NUMBER");
      rowData["STYLE NUMBER"] = vals;
      numCols = vals.length;
      continue;
    }

    // ── DESCRIPTION ──
    // Format quirk: values appear BEFORE the label (on the line between
    // STYLE NUMBER and DESCRIPTION), e.g.:
    //   STYLE NUMBER\t503\t504\t...
    //   Chair\tChair\t...               ← these are the descriptions
    //   DESCRIPTION                     ← label on its own
    if (line === "DESCRIPTION" || line.startsWith("DESCRIPTION\t")) {
      if (line.startsWith("DESCRIPTION\t")) {
        rowData["DESCRIPTION"] = splitTabs(line, "DESCRIPTION");
      } else {
        // Values were on the preceding line
        const prevLine = findPrevNonEmptyLine(lines, i);
        if (prevLine && prevLine.includes("\t") && !isLabelLine(prevLine)) {
          rowData["DESCRIPTION"] = prevLine.split("\t").map((v) => v.trim());
        }
      }
      continue;
    }

    // ── STYLE NAME ──
    // Same quirk as DESCRIPTION: values appear on the PRECEDING line
    // (between DESCRIPTION and STYLE NAME), e.g.:
    //   DESCRIPTION
    //   Colby\tConcavo\t...    ← these are the style names
    //   STYLE NAME              ← label on its own
    if (line === "STYLE NAME" || line.startsWith("STYLE NAME\t")) {
      if (line.startsWith("STYLE NAME\t")) {
        rowData["STYLE NAME"] = splitTabs(line, "STYLE NAME");
      } else {
        // Check preceding line first (most common case)
        const prevLine = findPrevNonEmptyLine(lines, i);
        if (prevLine && prevLine.includes("\t") && !isLabelLine(prevLine)) {
          rowData["STYLE NAME"] = prevLine.split("\t").map((v) => v.trim());
        } else {
          // Fall back to next line
          const nextLine = findNextNonEmptyLine(lines, i);
          if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
            rowData["STYLE NAME"] = nextLine.split("\t").map((v) => v.trim());
          }
        }
      }
      continue;
    }

    // ── Leather/Fabric Style Number ──
    if (line.startsWith("Leather Style Number\t")) {
      rowData["Leather Style Number"] = splitTabs(line, "Leather Style Number");
      continue;
    }
    if (line.startsWith("Fabric Style Number\t")) {
      rowData["Fabric Style Number"] = splitTabs(line, "Fabric Style Number");
      continue;
    }

    // ── Finish (but not "Decorative Finish") ──
    if (line.startsWith("Finish\t") && !line.startsWith("Decorative Finish")) {
      rowData["Finish"] = splitTabs(line, "Finish");
      continue;
    }
    if (line === "Finish") continue; // label alone, values on adjacent line

    // ── Decorative Finish ──
    if (line.startsWith("Decorative Finish\t")) {
      rowData["Decorative Finish"] = splitTabs(line, "Decorative Finish");
      continue;
    }
    if (line === "Decorative Finish") {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Decorative Finish"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // ── Standard Pillows ──
    if (line.startsWith("Standard Pillows\t")) {
      rowData["Standard Pillows"] = splitTabs(line, "Standard Pillows");
      continue;
    }
    if (line === "Standard Pillows") continue;

    // ── (COM) - fabric base price ──
    if (line.startsWith("(COM)\t")) {
      rowData["COM"] = splitTabs(line, "(COM)");
      continue;
    }

    // ── (COL) - leather base price ──
    if (line.startsWith("(COL)\t")) {
      rowData["COL"] = splitTabs(line, "(COL)");
      continue;
    }

    // ── GRADE row with grade code: " GRADE\t14\t..." or "GRADE\tC\t..." ──
    if (/^\s*GRADE\t/.test(line)) {
      const afterGrade = line.replace(/^\s*GRADE\t/, "");
      const parts = afterGrade.split("\t").map((v) => v.trim());
      if (parts.length >= 2) {
        const gradeCode = parts[0];
        const prices = parts.slice(1);
        if (ALL_GRADE_CODES.has(gradeCode)) {
          rowData[gradeCode] = prices;
        }
      }
      continue;
    }

    // ── Standalone grade row: "15\t1321\t1006\t..." or "D\t1910\t..." ──
    const gradeLineMatch = line.match(/^(\d{2}|[A-Z])\t(.+)/);
    if (gradeLineMatch) {
      const code = gradeLineMatch[1];
      if (ALL_GRADE_CODES.has(code)) {
        const prices = gradeLineMatch[2].split("\t").map((v) => v.trim());
        rowData[code] = prices;
        continue;
      }
    }

    // ── GRADE RISER ──
    if (line.startsWith("GRADE RISER\t")) {
      rowData["GRADE RISER"] = splitTabs(line, "GRADE RISER");
      continue;
    }

    // ── STANDARD SEAT ──
    if (line.startsWith("STANDARD SEAT\t")) {
      rowData["STANDARD SEAT"] = splitTabs(line, "STANDARD SEAT");
      continue;
    }

    // ── STANDARD BACK ──
    if (line.startsWith("STANDARD BACK\t")) {
      rowData["STANDARD BACK"] = splitTabs(line, "STANDARD BACK");
      continue;
    }

    // ── Spring-Down/BDB ──
    // Handles hyphenated and non-hyphenated variants, with or without "/BDB"
    if (
      line.startsWith("Spring-Down/BDB\t") ||
      line.startsWith("Spring Down/BDB\t") ||
      line.startsWith("Spring-Down\t") ||
      line.startsWith("Spring Down\t")
    ) {
      // Guard against matching "Spring Down Seat" (Foundations label)
      if (!line.startsWith("Spring Down Seat") && !line.startsWith("Spring-Down Seat")) {
        const labelEnd = line.indexOf("\t");
        rowData["Spring-Down/BDB"] = splitTabs(line, line.substring(0, labelEnd));
        continue;
      }
    }
    // Label alone on its own line
    if (/^Spring[\s-]Down(\/BDB)?$/.test(line)) {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Spring-Down/BDB"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // ── Comfort Down/BDB ──
    // Handles with or without "/BDB" suffix, label with values or alone
    if (
      line.startsWith("Comfort Down/BDB\t") ||
      (line.startsWith("Comfort Down\t") && !line.startsWith("Comfort Down/"))
    ) {
      const labelEnd = line.indexOf("\t");
      rowData["Comfort Down/BDB"] = splitTabs(line, line.substring(0, labelEnd));
      continue;
    }
    if (/^Comfort Down(\/BDB)?$/.test(line)) {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Comfort Down/BDB"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // ── Yardage (Plain / Pattern / Repeat) ──
    // Handles multiple label formats:
    //   "Ydg. Req. 54" Plain"         → plain yardage
    //   "Ydg.Req.-Repeat 3-13""       → small repeat (maps to comYardagePattern)
    //   "Ydg.Req.-Repeat 14-27""      → large repeat (maps to comYardageRepeat)
    //   "Ydg. Req. 54" Pattern"       → pattern yardage (alternate format)
    //   "Ydg. Req. 54" Repeat"        → repeat yardage (alternate format)
    const ydgPlainMatch = line.match(/^Ydg\.?\s*Req\.?\s*(?:54["\u201C\u201D\u2033]?\s*)?Plain/i);
    const ydgSmallRepeatMatch = line.match(/^Ydg\.?\s*Req\.?\s*-?\s*Repeat\s*\d+-\d+/i);
    const ydgPatternMatch = line.match(
      /^Ydg\.?\s*Req\.?\s*(?:54["\u201C\u201D\u2033]?\s*)?Pattern/i,
    );
    const ydgRepeatMatch = line.match(
      /^Ydg\.?\s*Req\.?\s*(?:54["\u201C\u201D\u2033]?\s*)?Repeat(?!\s*\d+-\d+)/i,
    );

    let ydgKey: string | null = null;
    if (ydgPlainMatch) {
      ydgKey = "Ydg Plain";
    } else if (ydgSmallRepeatMatch) {
      // First repeat line (e.g., 3-13") maps to comYardagePattern
      ydgKey = rowData["Ydg Pattern"] ? "Ydg Repeat" : "Ydg Pattern";
    } else if (ydgPatternMatch) {
      ydgKey = "Ydg Pattern";
    } else if (ydgRepeatMatch) {
      ydgKey = "Ydg Repeat";
    }

    if (ydgKey) {
      if (line.includes("\t")) {
        const labelEnd = line.indexOf("\t");
        rowData[ydgKey] = splitTabs(line, line.substring(0, labelEnd));
      } else {
        const nextLine = findNextNonEmptyLine(lines, i);
        if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
          rowData[ydgKey] = nextLine.split("\t").map((v) => v.trim());
        }
      }
      continue;
    }

    // ── COL sq. ft. (leather yardage equivalent) ──
    if (line.startsWith("COL - sq. ft.\t")) {
      rowData["COL sq ft"] = splitTabs(line, "COL - sq. ft.");
      continue;
    }

    // ── Available Nail Trim ──
    if (line.startsWith("AVAILABLE NAIL TRIM\t") || line.startsWith("Available Nail Trim\t")) {
      rowData["AVAILABLE NAIL TRIM"] = splitTabs(line, line.split("\t")[0]);
      continue;
    }

    // ── Arm Guards ──
    if (line.startsWith("Arm Guards\t") || line.startsWith("ARM GUARDS\t")) {
      rowData["Arm Guards"] = splitTabs(line, line.split("\t")[0]);
      continue;
    }
    if (line === "Arm Guards" || line === "ARM GUARDS") {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Arm Guards"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // ── Foundations-specific labels ──
    // These appear in Foundations price lists with the same tab-separated format
    if (line.startsWith("Foundations Cost\t")) {
      rowData["Foundations Cost"] = splitTabs(line, "Foundations Cost");
      continue;
    }
    if (line === "Foundations Cost") {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Foundations Cost"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    if (line.startsWith("CDC Seat/BDB Back\t")) {
      rowData["CDC Seat/BDB Back"] = splitTabs(line, "CDC Seat/BDB Back");
      continue;
    }
    if (line === "CDC Seat/BDB Back") {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["CDC Seat/BDB Back"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    if (/^(Ring Base Swivel|Swivel Base|Swivel)\t/i.test(line)) {
      const tabIdx = line.indexOf("\t");
      rowData["Ring Base Swivel"] = line
        .substring(tabIdx + 1)
        .split("\t")
        .map((v) => v.trim());
      continue;
    }
    if (/^(Ring Base Swivel|Swivel Base|Swivel)$/i.test(line)) {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Ring Base Swivel"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // Castors (may appear as "Castors", "Casters", or "Castor" in WH price lists)
    if (/^Cast[eo]rs?\t/i.test(line)) {
      const tabIdx = line.indexOf("\t");
      rowData["Castors"] = line
        .substring(tabIdx + 1)
        .split("\t")
        .map((v) => v.trim());
      continue;
    }
    if (/^Cast[eo]rs?$/i.test(line)) {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Castors"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // Nailhead Trim (distinct from AVAILABLE NAIL TRIM in wholesale)
    if (line.startsWith("Nailhead Trim\t") && !rowData["AVAILABLE NAIL TRIM"]) {
      rowData["Nailhead Trim"] = splitTabs(line, "Nailhead Trim");
      continue;
    }
    if (line === "Nailhead Trim" && !rowData["AVAILABLE NAIL TRIM"]) {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Nailhead Trim"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // Spring-Down Seat (Foundations uses "Spring-Down Seat" vs wholesale "Spring-Down/BDB")
    if (line.startsWith("Spring-Down Seat\t")) {
      rowData["Spring-Down Seat"] = splitTabs(line, "Spring-Down Seat");
      continue;
    }
    if (line === "Spring-Down Seat") {
      const nextLine = findNextNonEmptyLine(lines, i);
      if (nextLine && nextLine.includes("\t") && !isLabelLine(nextLine)) {
        rowData["Spring-Down Seat"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }

    // ── Dimension text detection ──
    // Wesley Hall format: tab-separated dimension cells followed by "L x D x H".
    // Handles: "30 x 41 x 37", "30" x 41" x 37"", "24½ x 28 x 33½",
    // "30"W x 41"D x 37"H", and variants with smart quotes or prime marks.
    // Inch marks: " (U+0022), \u201C, \u201D, \u2033 (double prime)
    const INCH = `["\u201C\u201D\u2033]`;
    const dimWithLettersRegex = new RegExp(
      `(\\d+(?:[½¼¾]|\\.\\d+)?)${INCH}?\\s*[LW]\\s*x\\s*(\\d+(?:[½¼¾]|\\.\\d+)?)${INCH}?\\s*D\\s*x\\s*(\\d+(?:[½¼¾]|\\.\\d+)?)${INCH}?\\s*H`,
      "i",
    );

    // Bare dimension with optional inch marks and fractions
    const bareDimRegex = new RegExp(
      `^(\\d+[½¼¾]?)${INCH}?\\s*x\\s*(\\d+[½¼¾]?)${INCH}?\\s*x\\s*(\\d+[½¼¾]?)${INCH}?$`,
    );

    // Check if the next non-empty line is the "L x D x H" header
    const isNextLineDimHeader = (): boolean => {
      const next = findNextNonEmptyLine(lines, i);
      return !!next && /^\s*[LW]\s*x\s*D\s*x\s*H\s*$/i.test(next);
    };

    // Tab-separated bare dimensions (Wesley Hall format)
    if (line.includes("\t") && !rowData["OVERALL_W"]) {
      const cells = line.split("\t");
      let bareMatches = 0;
      for (const cell of cells) {
        if (bareDimRegex.test(cell.trim())) bareMatches++;
      }
      // If most cells match bare dimension format, or the next line is "L x D x H"
      if (bareMatches >= 2 || (bareMatches >= 1 && isNextLineDimHeader())) {
        rowData["OVERALL_W"] = [];
        rowData["OVERALL_D"] = [];
        rowData["OVERALL_H"] = [];
        let dataIdx = 0;
        for (const cell of cells) {
          const m = cell.trim().match(bareDimRegex);
          if (m) {
            rowData["OVERALL_W"][dataIdx] = parseFraction(m[1]);
            rowData["OVERALL_D"][dataIdx] = parseFraction(m[2]);
            rowData["OVERALL_H"][dataIdx] = parseFraction(m[3]);
            dataIdx++;
          }
        }
        continue;
      }
    }

    // Inline "N"L x N"D x N"H" format (tab-separated)
    if (line.includes("\t") && !rowData["OVERALL_W"]) {
      const cells = line.split("\t");
      let dimMatches = 0;
      for (const cell of cells) {
        if (dimWithLettersRegex.test(cell)) dimMatches++;
      }
      if (dimMatches > 0) {
        rowData["OVERALL_W"] = [];
        rowData["OVERALL_D"] = [];
        rowData["OVERALL_H"] = [];
        let dataIdx = 0;
        for (const cell of cells) {
          const cellMatch = cell.match(dimWithLettersRegex);
          if (cellMatch) {
            rowData["OVERALL_W"][dataIdx] = parseFraction(cellMatch[1]);
            rowData["OVERALL_D"][dataIdx] = parseFraction(cellMatch[2]);
            rowData["OVERALL_H"][dataIdx] = parseFraction(cellMatch[3]);
            dataIdx++;
          }
        }
        continue;
      }
    }

    // Single dimension match (broadcast to all columns)
    if (!rowData["OVERALL_W"]) {
      const overallMatch = line.match(dimWithLettersRegex) || line.trim().match(bareDimRegex);
      if (overallMatch) {
        rowData["OVERALL_W"] = [];
        rowData["OVERALL_D"] = [];
        rowData["OVERALL_H"] = [];
        for (let c = 0; c < Math.max(numCols, 1); c++) {
          rowData["OVERALL_W"][c] = parseFraction(overallMatch[1]);
          rowData["OVERALL_D"][c] = parseFraction(overallMatch[2]);
          rowData["OVERALL_H"][c] = parseFraction(overallMatch[3]);
        }
      }
    }

    // Skip the "L x D x H" header line
    if (/^\s*[LW]\s*x\s*D\s*x\s*H\s*$/i.test(line)) continue;

    // Seat Height: "SH: 20" or "Seat Height 20"" or "Seat Ht: 20"
    const seatHtMatch = line.match(/(?:Seat\s*(?:Height|Ht|Ht\.)|SH)\s*:?\s*(\d+(?:\.\d+)?)/i);
    if (seatHtMatch && !rowData["SEAT_HT"]) {
      rowData["SEAT_HT"] = [];
      for (let c = 0; c < Math.max(numCols, 1); c++) {
        rowData["SEAT_HT"][c] = seatHtMatch[1];
      }
    }

    // Arm Height: "AH: 25" or "Arm Height 25"" or "Arm Ht: 25"
    const armHtMatch = line.match(/(?:Arm\s*(?:Height|Ht|Ht\.)|AH)\s*:?\s*(\d+(?:\.\d+)?)/i);
    if (armHtMatch && !rowData["ARM_HT"]) {
      rowData["ARM_HT"] = [];
      for (let c = 0; c < Math.max(numCols, 1); c++) {
        rowData["ARM_HT"][c] = armHtMatch[1];
      }
    }

    // Seat Depth: "SD: 22" or "Seat Depth 22""
    const seatDpMatch = line.match(/(?:Seat\s*Depth|SD)\s*:?\s*(\d+(?:\.\d+)?)/i);
    if (seatDpMatch && !rowData["SEAT_DP"]) {
      rowData["SEAT_DP"] = [];
      for (let c = 0; c < Math.max(numCols, 1); c++) {
        rowData["SEAT_DP"][c] = seatDpMatch[1];
      }
    }
  }

  // ── Phase 2: Transpose columns → product records ──

  const styleNumbers = rowData["STYLE NUMBER"] || [];
  if (numCols === 0) numCols = styleNumbers.length;
  if (numCols === 0) return [];

  const products: WholesaleRawRow[] = [];

  for (let col = 0; col < numCols; col++) {
    const gradePrices: Record<string, string> = {};

    // Base price (COM for fabric, COL for leather)
    if (rowData["COM"]?.[col]) {
      gradePrices["COM"] = rowData["COM"][col];
    }
    if (rowData["COL"]?.[col]) {
      gradePrices["COL"] = rowData["COL"][col];
    }

    // Fabric grades (14-35)
    for (const grade of FABRIC_GRADES) {
      if (rowData[grade]?.[col]) {
        gradePrices[grade] = rowData[grade][col];
      }
    }

    // Leather grades (C-Z)
    for (const grade of LEATHER_GRADES) {
      if (rowData[grade]?.[col]) {
        gradePrices[grade] = rowData[grade][col];
      }
    }

    products.push({
      styleNumber: styleNumbers[col] || "",
      description: rowData["DESCRIPTION"]?.[col] || "",
      styleName: rowData["STYLE NAME"]?.[col] || "",
      leatherStyleNumber:
        rowData["Leather Style Number"]?.[col] || rowData["Fabric Style Number"]?.[col] || "",
      finish: rowData["Finish"]?.[col] || "",
      decorativeFinish: rowData["Decorative Finish"]?.[col] || "",
      standardPillows: rowData["Standard Pillows"]?.[col] || "",
      gradeRiser: rowData["GRADE RISER"]?.[col] || "",
      standardSeat: rowData["STANDARD SEAT"]?.[col] || "",
      standardBack: rowData["STANDARD BACK"]?.[col] || "",
      springDownBdb: rowData["Spring-Down/BDB"]?.[col] || "",
      comfortDownBdb: rowData["Comfort Down/BDB"]?.[col] || "",
      yardagePlain: rowData["Ydg Plain"]?.[col] || rowData["COL sq ft"]?.[col] || "",
      yardagePattern: rowData["Ydg Pattern"]?.[col] || "",
      yardageRepeat: rowData["Ydg Repeat"]?.[col] || "",
      availableNailTrim: rowData["AVAILABLE NAIL TRIM"]?.[col] || "",
      armGuards: rowData["Arm Guards"]?.[col] || "",
      gradePrices,
      overallWidth: rowData["OVERALL_W"]?.[col] || "",
      overallDepth: rowData["OVERALL_D"]?.[col] || "",
      overallHeight: rowData["OVERALL_H"]?.[col] || "",
      seatHeight: rowData["SEAT_HT"]?.[col] || "",
      armHeight: rowData["ARM_HT"]?.[col] || "",
      seatDepth: rowData["SEAT_DP"]?.[col] || "",
      // Foundations-specific fields
      foundationsCost: rowData["Foundations Cost"]?.[col] || "",
      cdcSeatBdbBack: rowData["CDC Seat/BDB Back"]?.[col] || "",
      ringBaseSwivel: rowData["Ring Base Swivel"]?.[col] || "",
      castors: rowData["Castors"]?.[col] || "",
      nailheadTrim: rowData["Nailhead Trim"]?.[col] || "",
      springDownSeat: rowData["Spring-Down Seat"]?.[col] || "",
      pageNumber: 0, // Set by caller after parsePageChunk returns
    });
  }

  // Filter out empty/invalid products
  // Wholesale products need grade prices; Foundations products need foundationsCost
  return products.filter(
    (p) =>
      p.styleNumber &&
      p.styleNumber !== "N/A" &&
      (Object.keys(p.gradePrices).length > 0 || !!p.foundationsCost),
  );
}

// ─── Fabric catalog PDF extractor ────────────────────────────────
//
// Parses Wesley Hall fabric palette/catalog PDFs.
//
// These PDFs have NO header row. Each line contains 2-3 columns of
// fabric entries where pattern+color+grade are concatenated:
//   Sherman Driftwood28Millbridge Biscotti27Amsterdam High Plains
//   Whitman Rattan (WHP)50Marlow Walnut (R)39Eureka Biscotti
//
// Each fabric entry is: PatternName ColorName(OptionalAbbrev)GradeNumber
// The rightmost entry on a line may be leather (no grade) — skip it.
//
// Strategy: split each line at grade-number boundaries using
// split(/(\d{2,4})(?=[A-Z]|$)/) instead of a single complex regex.

export interface FabricParsedRow {
  fabricName: string;
  colorName: string;
  grade: string;
}

// Lines to skip — non-fabric content found in Wesley Hall PDFs
const FABRIC_SKIP_PATTERNS = [
  /^Fabric\s*\|/i,
  /^Handle\s*\d/i,
  /^NOTE:/i,
  /^DROPS\s*-/i,
  /^\d+$/,
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i,
  /^[A-Z][a-z]+\s+\d{4}$/,
  /^Warning:/i,
  /^TABLE OF CONTENTS/i,
  /^GENERAL INFORMATION/i,
  /^FABRIC BY THE YARD/i,
  /^GRADE\s+PRICE/i,
  /^SLEEP\s+SOFAS/i,
  /^SECTIONAL/i,
  /^RING BASE/i,
  /^CONTRASTING/i,
  /^WELT/i,
  /^SKIRT/i,
  /^Sofa\s+Loveseat/i,
  /^\d+\.\s/,
  /^Leathers$/i,
  /^In Stock/i,
  /^On Order/i,
  /^Closeout/i,
];

const FALSE_POSITIVE_NAMES =
  /^(OCT|NOV|DEC|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|DROPS|NOTE|Handle|Page|Grade|Leather|Fabric|STYLE|NUMBER|COM|COL)$/i;

function isLikelyGrade(n: string): boolean {
  const num = Number.parseInt(n, 10);
  return !isNaN(num) && num >= 10 && num <= 2000;
}

/**
 * Extract fabric catalog entries from a Wesley Hall fabric palette PDF.
 * Returns structured rows with fabricName, colorName, and grade.
 */
export async function extractFabricCatalog(pdfBuffer: Buffer): Promise<FabricParsedRow[]> {
  const data = await pdf(pdfBuffer);
  const lines = data.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const results: FabricParsedRow[] = [];

  for (const line of lines) {
    if (FABRIC_SKIP_PATTERNS.some((p) => p.test(line))) continue;
    if (line.length < 5) continue;

    // Split line at grade-number boundaries. A grade number is 2-4 digits
    // followed by an uppercase letter (next entry) or end of string.
    // Capturing group keeps grade numbers in the result array:
    //   "Sherman Driftwood28Millbridge Biscotti27"
    //   -> ["Sherman Driftwood", "28", "Millbridge Biscotti", "27", ""]
    const parts = line.split(/(\d{2,4})(?=[A-Z]|$)/);

    // Alternating pairs: parts[0]=text, parts[1]=grade, parts[2]=text, ...
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const textPart = parts[i].trim();
      const gradePart = parts[i + 1];

      if (!textPart || !gradePart) continue;
      if (!isLikelyGrade(gradePart)) continue;

      // Split text into fabricName + colorName.
      // Strip trailing abbreviation like (WHP), (CH), (R)
      const withoutAbbrev = textPart.replace(/\s*\([A-Za-z]+\)\s*$/, "").trim();
      const words = withoutAbbrev.split(/\s+/);

      let fabricName: string;
      let colorName: string;

      if (words.length >= 2) {
        colorName = words.pop()!;
        fabricName = words.join(" ");
        const abbrevMatch = textPart.match(/\([A-Za-z]+\)\s*$/);
        if (abbrevMatch) {
          colorName += " " + abbrevMatch[0].trim();
        }
      } else {
        fabricName = textPart;
        colorName = "";
      }

      if (fabricName.length < 2) continue;
      if (FALSE_POSITIVE_NAMES.test(fabricName)) continue;

      const key = `${fabricName}|||${colorName}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ fabricName, colorName, grade: gradePart });
    }
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Split a tab-delimited line after removing its label prefix.
 */
/** Convert fraction characters (½ ¼ ¾) to decimal strings: "15½" → "15.5". */
function parseFraction(s: string): string {
  return s.replace(/½/g, ".5").replace(/¼/g, ".25").replace(/¾/g, ".75");
}

function splitTabs(line: string, label: string): string[] {
  const startIdx = line.indexOf(label) + label.length;
  const remainder = line.substring(startIdx);
  // The first character after the label should be a tab
  return remainder
    .replace(/^\t/, "")
    .split("\t")
    .map((v) => v.trim());
}

/**
 * Find the previous non-empty line (looking backward from index).
 */
function findPrevNonEmptyLine(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex - 1; j >= Math.max(0, fromIndex - 3); j--) {
    const l = lines[j].trim();
    if (l) return l;
  }
  return null;
}

/**
 * Find the next non-empty line (looking forward from index).
 */
function findNextNonEmptyLine(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex + 1; j < Math.min(lines.length, fromIndex + 3); j++) {
    const l = lines[j].trim();
    if (l) return l;
  }
  return null;
}

/**
 * Check if a line starts with a known label (to avoid consuming
 * label lines as value lines when scanning ahead/behind).
 */
function isLabelLine(line: string): boolean {
  const labels = [
    "STYLE NUMBER",
    "DESCRIPTION",
    "STYLE NAME",
    "Leather Style Number",
    "Fabric Style Number",
    "Finish",
    "Decorative Finish",
    "Standard Pillows",
    "(COM)",
    "(COL)",
    "GRADE RISER",
    "STANDARD SEAT",
    "STANDARD BACK",
    "Spring-Down",
    "Spring Down",
    "Comfort Down",
    "Ydg",
    "COL - sq.",
    "AVAILABLE NAIL TRIM",
    "Available Nail Trim",
    "Arm Guards",
    "ARM GUARDS",
    // Foundations-specific labels
    "Foundations Cost",
    "CDC Seat/BDB Back",
    "Ring Base Swivel",
    "Swivel Base",
    "Swivel",
    "Nailhead Trim",
    "Spring-Down Seat",
  ];
  const trimmed = line.trim();
  if (labels.some((l) => trimmed.startsWith(l))) return true;
  // Date lines (e.g., "October 2025", "March 2026") appear in price list headers
  if (
    /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Dimension lines ("30 x 41 x 37", "30" x 41" x 37"") should not be
  // consumed as description/style name values by prev-line lookups
  if (/\d+[½¼¾"\u201C\u201D\u2033]?\s*x\s*\d+[½¼¾"\u201C\u201D\u2033]?\s*x\s*\d+/.test(trimmed)) {
    return true;
  }
  // "L x D x H" dimension header
  if (/^[LW]\s*x\s*D\s*x\s*H$/i.test(trimmed)) return true;
  // GRADE header row
  if (/^\s*GRADE\t/.test(trimmed)) return true;
  return false;
}
