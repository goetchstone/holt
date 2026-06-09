// /app/src/lib/pricing/crLaineExtractor.ts
//
// Server-side PDF table extractor for CR Laine price lists.
// CR Laine uses a columnar layout (products side-by-side) similar to
// Wesley Hall, but with different row labels and grade structure.
//
// Key differences from Wesley Hall:
// - Row labels: NAME, STYLE NO., Description, Dimension, Weight, etc.
// - Grade 7 and COM are combined: "7/COM" row has the base fabric price
// - Grades run from 7 to 25 explicitly, with "Add for each Grade > 25"
// - Leather grades: COL + numeric 7-12, with "Add for each Grade > 12"
// - Options: Hallmark, Mayfair, Comfort Down, Harmony, Hamilton Spring Down,
//   Fiber, Legacy Down, Extra Full
// - Page footers: "32\tWholesale" pattern

import pdf from "pdf-parse";
import { columnAwarePageRenderer, extractPdfText, splitTabs } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";
import { ParsedWholesaleProduct, ParsedFoundationsProduct } from "./wesleyHallParser";

// ─── Grade labels ────────────────────────────────────────────────

// Fabric grades for CR Laine (7 through 25 explicit, plus riser for higher)
const CR_FABRIC_GRADES = [
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
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
];

// Leather grades (same numeric range, typically 7-12 explicit)
const CR_LEATHER_GRADES = ["7", "8", "9", "10", "11", "12"];

// All possible grade codes for line matching
const ALL_GRADE_CODES = new Set([
  ...CR_FABRIC_GRADES,
  ...Array.from({ length: 36 }, (_, i) => String(i + 25)), // 25-60 for extended range
]);

// ─── Main extraction: Wholesale ──────────────────────────────────

/**
 * Extract wholesale pricing data from a CR Laine price list PDF.
 *
 * Uses pdf-parse directly with a page-marker renderer so each product
 * gets tagged with its physical PDF page number. This is required by the
 * image extraction pipeline to map line drawings to the correct products.
 */
export async function extractCrLaineWholesale(
  pdfBuffer: Buffer,
): Promise<ParsedWholesaleProduct[]> {
  const data = await pdf(pdfBuffer, {
    pagerender: (pageData: any) =>
      columnAwarePageRenderer(pageData).then(
        (text: string) => `<<PAGE:${pageData.pageNumber}>>\n${text}`,
      ),
  });

  const allProducts: ParsedWholesaleProduct[] = [];

  // Split by page markers. The capturing group in the regex causes split()
  // to interleave page numbers and page text:
  // [preamble, "1", page1text, "2", page2text, ...]
  const segments = data.text.split(/<<PAGE:(\d+)>>\n/);

  for (let i = 1; i < segments.length; i += 2) {
    const pageNumber = Number.parseInt(segments[i], 10);
    const pageText = segments[i + 1] || "";

    // splitIntoPages finds NAME\t boundaries within this page's text
    const chunks = splitIntoPages(pageText);
    for (const chunk of chunks) {
      const products = parsePageChunk(chunk);
      for (const p of products) {
        p.pageNumber = pageNumber;
      }
      allProducts.push(...products);
    }
  }

  return mergeProducts(allProducts);
}

// ─── Main extraction: Simplicity ─────────────────────────────────

/**
 * Extract Simplicity program pricing from a CR Laine PDF.
 * Simplicity uses grades A, B, C (flat-ish pricing, 3 tiers).
 * We map grade A as the "Simplicity Price" (foundationsCost).
 */
export async function extractCrLaineSimplicity(
  pdfBuffer: Buffer,
): Promise<ParsedFoundationsProduct[]> {
  const text = await extractPdfText(pdfBuffer);
  const pageChunks = splitIntoPages(text);
  const allProducts: ParsedFoundationsProduct[] = [];

  for (const chunk of pageChunks) {
    const products = parseSimplicityPageChunk(chunk);
    allProducts.push(...products);
  }

  return allProducts;
}

// ─── Split text into page-sized chunks ────────────────────────────

function splitIntoPages(text: string): string[] {
  const chunks: string[] = [];

  // CR Laine pages start with "NAME\t" followed by style names
  const regex = /^NAME\t/gm;
  const matches: number[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match.index);
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1] : text.length;
    chunks.push(text.substring(start, end));
  }

  return chunks;
}

// ─── Dimension parsing ──────────────────────────────────────────

interface ParsedDimensions {
  width: number | null;
  depth: number | null;
  height: number | null;
  seatHeight: number | null;
  armHeight: number | null;
  seatDepth: number | null;
}

/**
 * Parse a CR Laine dimension string into separate measurements.
 * Common formats:
 *   "W38 D40 H37"
 *   "38W x 40D x 37H"
 *   "38 x 40 x 37"
 *   "W 38 D 40 H 37"
 *   "38\"W x 40\"D x 37\"H"
 *   "SH: 18  AH: 25  SD: 22"
 */
function parseDimensionString(dimStr: string): ParsedDimensions {
  const result: ParsedDimensions = {
    width: null,
    depth: null,
    height: null,
    seatHeight: null,
    armHeight: null,
    seatDepth: null,
  };

  if (!dimStr || dimStr === "-" || dimStr === "--") return result;

  const s = dimStr.replace(/"/g, "").replace(/'/g, "");

  // Try labeled patterns: W38, D40, H37, SH18, AH25, SD22
  const wMatch = s.match(/W\s*(\d+(?:\.\d+)?)/i);
  const dMatch = s.match(/(?<![AS])D\s*(\d+(?:\.\d+)?)/i);
  const hMatch = s.match(/(?<![AS])H\s*(\d+(?:\.\d+)?)/i);
  const shMatch = s.match(/SH\s*:?\s*(\d+(?:\.\d+)?)/i);
  const ahMatch = s.match(/AH\s*:?\s*(\d+(?:\.\d+)?)/i);
  const sdMatch = s.match(/SD\s*:?\s*(\d+(?:\.\d+)?)/i);

  if (wMatch) result.width = Number.parseFloat(wMatch[1]);
  if (dMatch) result.depth = Number.parseFloat(dMatch[1]);
  if (hMatch) result.height = Number.parseFloat(hMatch[1]);
  if (shMatch) result.seatHeight = Number.parseFloat(shMatch[1]);
  if (ahMatch) result.armHeight = Number.parseFloat(ahMatch[1]);
  if (sdMatch) result.seatDepth = Number.parseFloat(sdMatch[1]);

  // Fallback: three bare numbers separated by x or spaces (W x D x H order)
  if (result.width === null && result.depth === null && result.height === null) {
    const nums = s.match(/(\d+(?:\.\d+)?)\s*[x×\s]+\s*(\d+(?:\.\d+)?)\s*[x×\s]+\s*(\d+(?:\.\d+)?)/);
    if (nums) {
      result.width = Number.parseFloat(nums[1]);
      result.depth = Number.parseFloat(nums[2]);
      result.height = Number.parseFloat(nums[3]);
    }
  }

  return result;
}

// ─── Parse a single wholesale pricing page ───────────────────────

function parsePageChunk(chunk: string): ParsedWholesaleProduct[] {
  const lines = chunk.split("\n").map((l) => l.trimEnd());

  // ── Phase 1: Extract labeled rows ──
  const rowData: Record<string, string[]> = {};
  let numCols = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Skip page footer lines like "32\tWholesale" or "32 Wholesale"
    if (/^\d+\s+(Wholesale|Simplicity)/i.test(line)) continue;

    // ── NAME (style name) ──
    if (line.startsWith("NAME\t")) {
      const vals = splitTabs(line, "NAME");
      rowData["NAME"] = vals;
      numCols = vals.length;
      continue;
    }

    // ── STYLE NO. (style number) ──
    if (line.startsWith("STYLE NO.\t")) {
      rowData["STYLE NO."] = splitTabs(line, "STYLE NO.");
      continue;
    }

    // ── Description ──
    // Sometimes appears as "Description\t..." or just "Description" alone
    // with values on the preceding line
    if (line === "Description" || line.startsWith("Description\t")) {
      if (line.startsWith("Description\t")) {
        rowData["Description"] = splitTabs(line, "Description");
      } else {
        // Check preceding line
        const prevLine = findPrevDataLine(lines, i);
        if (prevLine) {
          rowData["Description"] = prevLine.split("\t").map((v) => v.trim());
        }
      }
      continue;
    }

    // ── Dimension ──
    if (line.startsWith("Dimension")) {
      // "Dimension - W x D x H\t..." or similar
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["Dimension"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }

    // ── Weight ──
    if (line.startsWith("Weight")) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["Weight"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }

    // ── Back Style ──
    if (line.startsWith("Back Style\t") || line.startsWith("Back Style -\t")) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["Back Style"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }

    // ── COM Yardage — Plain / Pattern / Repeat ──
    if (
      line.startsWith("COM Yardage -   Plain\t") ||
      line.startsWith("COM Yardage -  Plain\t") ||
      line.startsWith("COM Yardage - Plain\t")
    ) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["COM Yardage"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }
    // CR Laine labels: 'COM Yardage-  2"-14" Rpt' (small repeat) and
    // 'COM Yardage-15"-27" Rpt' (large repeat). Also handles the generic
    // "Pattern" / "Repeat" labels in case format varies across editions.
    if (/^COM Yardage\s*-?\s*(2|Pattern)/i.test(line)) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["COM Yardage Pattern"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }
    if (/^COM Yardage\s*-?\s*(15|Repeat)/i.test(line)) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["COM Yardage Repeat"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }
    if (line.startsWith("COM Yardage-") || line.startsWith("COM Yardage -")) continue; // Skip unrecognized yardage variant rows

    // ── StdNail (standard nailhead trim) ──
    if (line.startsWith("StdNail\t") || line.startsWith("StdNail Size")) {
      rowData["StdNail"] = splitOptionValues(line, numCols);
      continue;
    }

    // ── Cushion options ──
    if (/^\s*Comfort Down\t/.test(line) && !line.includes("Back")) {
      rowData["Comfort Down"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/Harmony\t/.test(line) && !line.startsWith("BACK")) {
      // The Harmony line may have a CUSHION section header prefix:
      // "CUSHION\t  Harmony\t60\t..." — strip the prefix so values align.
      const adjusted = /^CUSHION\t/.test(line) ? line.substring(line.indexOf("\t") + 1) : line;
      rowData["Harmony"] = splitOptionValues(adjusted, numCols);
      continue;
    }
    if (/Hamilton Spring Down\t/.test(line)) {
      rowData["Hamilton Spring Down"] = splitOptionValues(line, numCols);
      continue;
    }

    // ── Additional cushion/back options ──
    if (/^\s*Hallmark\t/.test(line)) {
      rowData["Hallmark"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/^\s*Mayfair\t/.test(line)) {
      rowData["Mayfair"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/^\s*Fiber\t/.test(line)) {
      rowData["Fiber"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/Legacy Down\t/.test(line)) {
      rowData["Legacy Down"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/Extra Full\t/.test(line)) {
      rowData["Extra Full"] = splitOptionValues(line, numCols);
      continue;
    }

    // ── 7/COM (fabric base price — combined grade 7 and COM) ──
    if (line.startsWith("7/COM\t")) {
      rowData["7/COM"] = splitTabs(line, "7/COM");
      continue;
    }

    // ── Standalone fabric grade rows: "8\t...", "9\t...", etc. ──
    // Also handles split lines where grade number is alone (e.g. "9")
    // and prices are on the next line (PDF rendering artifact).
    const fabricGradeMatch = line.match(/^(\d{1,2})\t(.+)/);
    if (fabricGradeMatch) {
      const code = fabricGradeMatch[1];
      const num = Number.parseInt(code);
      if (num >= 8 && num <= 60) {
        const prices = fabricGradeMatch[2].split("\t").map((v) => v.trim());
        if (rowData["COL"]) {
          rowData[`L${code}`] = prices;
        } else {
          rowData[code] = prices;
        }
        continue;
      }
    }

    // ── Split-line grade: grade number alone on one line, prices on next ──
    const splitGradeMatch = line.match(/^(\d{1,2})$/);
    if (splitGradeMatch) {
      const code = splitGradeMatch[1];
      const num = Number.parseInt(code);
      if (num >= 8 && num <= 60) {
        // Look ahead for the prices on the next non-empty line
        const nextLine = findNextDataLineRaw(lines, i);
        if (nextLine && /^\d/.test(nextLine)) {
          const prices = nextLine.split("\t").map((v) => v.trim());
          if (rowData["COL"]) {
            rowData[`L${code}`] = prices;
          } else {
            rowData[code] = prices;
          }
        }
        continue;
      }
    }

    // ── "Add for each Grade > 25" (fabric grade riser) ──
    if (
      line.startsWith("Add for each Grade > 25\t") ||
      line.startsWith("Add for each Grade >25\t")
    ) {
      rowData["GRADE_RISER_FABRIC"] = splitTabsAfterFirst(line);
      continue;
    }
    // Some products have different riser thresholds
    const fabricRiserMatch = line.match(/^Add for each Grade\s*>\s*(\d+)\t(.+)/);
    if (fabricRiserMatch && !rowData["COL"]) {
      rowData["GRADE_RISER_FABRIC"] = fabricRiserMatch[2].split("\t").map((v) => v.trim());
      rowData["GRADE_RISER_FABRIC_THRESHOLD"] = Array(numCols).fill(fabricRiserMatch[1]);
      continue;
    }

    // ── LEATHER STYLE ──
    if (line.startsWith("LEATHER STYLE")) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["LEATHER STYLE"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }

    // ── COL Square Feet ──
    if (line.startsWith("COL Square Feet\t")) {
      rowData["COL Square Feet"] = splitTabs(line, "COL Square Feet");
      continue;
    }

    // ── COL (leather base price) ──
    if (line.startsWith("COL\t")) {
      rowData["COL"] = splitTabs(line, "COL");
      continue;
    }

    // ── Leather grade riser ──
    if (
      line.startsWith("Add for each Grade > 12\t") ||
      line.startsWith("Add for each Grade >12\t")
    ) {
      rowData["GRADE_RISER_LEATHER"] = splitTabsAfterFirst(line);
      continue;
    }
    const leatherRiserMatch = line.match(/^Add for each Grade\s*>\s*(\d+)\t(.+)/);
    if (leatherRiserMatch && rowData["COL"]) {
      rowData["GRADE_RISER_LEATHER"] = leatherRiserMatch[2].split("\t").map((v) => v.trim());
      continue;
    }

    // ── Prem Finish Upcharge ──
    if (line.startsWith("Prem Finish Upcharge")) {
      rowData["Prem Finish"] = splitOptionValues(line, numCols);
      continue;
    }

    // ── Contrast Welt ──
    if (line.startsWith("Contrast Welt All")) {
      rowData["Contrast Welt"] = splitOptionValues(line, numCols);
      continue;
    }

    // ── Contrast Bias Welt ──
    if (line.startsWith("Cont Bias Welt All")) {
      rowData["Contrast Bias Welt"] = splitOptionValues(line, numCols);
      continue;
    }

    // ── Back fill options ──
    // These have " Back" suffix. Some lines have a "BACK\t" section header
    // prefix which causes column misalignment; skip those (Fiber Luxe Back).
    if (/^\s+Fiber Back\t/.test(line)) {
      rowData["Fiber Back"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/^\s+Comfort Down Back\t/.test(line)) {
      rowData["Comfort Down Back"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/^\s+Legacy Down Back\t/.test(line)) {
      rowData["Legacy Down Back"] = splitOptionValues(line, numCols);
      continue;
    }
    if (/^\s+Extra Full Back\t/.test(line)) {
      rowData["Extra Full Back"] = splitOptionValues(line, numCols);
      continue;
    }
  }

  // ── Phase 2: Transpose columns → product records ──

  const styleNumbers = rowData["STYLE NO."] || [];
  const names = rowData["NAME"] || [];
  if (numCols === 0) numCols = styleNumbers.length;
  if (numCols === 0) return [];

  const products: ParsedWholesaleProduct[] = [];

  for (let col = 0; col < numCols; col++) {
    const gradePrices: { grade: string; cost: number }[] = [];

    // COM / Grade 7 combined price
    const comPrice = rowData["7/COM"]?.[col];
    if (comPrice) {
      const cost = parseCurrency(comPrice);
      if (!isNaN(cost) && cost > 0) {
        gradePrices.push({ grade: "COM", cost });
        gradePrices.push({ grade: "7", cost });
      }
    }

    // Fabric grades 8-25 (and beyond if explicitly listed)
    for (let g = 8; g <= 60; g++) {
      const val = rowData[String(g)]?.[col];
      if (val) {
        const cost = parseCurrency(val);
        if (!isNaN(cost) && cost > 0) {
          gradePrices.push({ grade: String(g), cost });
        }
      }
    }

    // COL (leather base price)
    const colPrice = rowData["COL"]?.[col];
    if (colPrice) {
      const cost = parseCurrency(colPrice);
      if (!isNaN(cost) && cost > 0) {
        gradePrices.push({ grade: "COL", cost });
      }
    }

    // Leather grades
    for (let g = 7; g <= 25; g++) {
      const val = rowData[`L${g}`]?.[col];
      if (val) {
        const cost = parseCurrency(val);
        if (!isNaN(cost) && cost > 0) {
          // Store leather grades with L prefix temporarily to distinguish
          // from fabric grades (they overlap — both use numeric codes)
          // We'll separate them in the import API via the COL presence
          gradePrices.push({ grade: `L${g}`, cost });
        }
      }
    }

    if (gradePrices.length === 0) continue;

    const styleNumber = styleNumbers[col] || "";
    if (!styleNumber || styleNumber === "-" || styleNumber === "------") continue;

    const description = rowData["Description"]?.[col] || "";
    const styleName = names[col] || "";
    const yardageStr = rowData["COM Yardage"]?.[col] || "";
    const yardage = parseOptionalNumber(yardageStr);

    // Grade riser for fabric
    const fabricRiserStr = rowData["GRADE_RISER_FABRIC"]?.[col] || "";
    const fabricRiser = parseOptionalNumber(fabricRiserStr);

    // Yardage — pattern and repeat
    const yardagePatternStr = rowData["COM Yardage Pattern"]?.[col] || "";
    const yardageRepeatStr = rowData["COM Yardage Repeat"]?.[col] || "";

    // Dimensions — parse W x D x H and secondary measurements
    const dimStr = rowData["Dimension"]?.[col] || "";
    const dims = parseDimensionString(dimStr);

    // Back style (e.g., "Tight", "Loose Pillow", "Box Border")
    const backStyle = rowData["Back Style"]?.[col]?.trim() || null;

    // Cushion surcharges — use parseOptionValue to detect "Std"
    const springDown = parseOptionValue(rowData["Hamilton Spring Down"]?.[col] || "");
    const comfortDown = parseOptionValue(rowData["Comfort Down"]?.[col] || "");
    const harmony = parseOptionValue(rowData["Harmony"]?.[col] || "");

    // Decorative finish
    const premFinish = parseOptionValue(rowData["Prem Finish"]?.[col] || "");

    // Nailhead trim
    const nailhead = parseOptionValue(rowData["StdNail"]?.[col] || "");

    // Welting options
    const contrastWelt = parseOptionValue(rowData["Contrast Welt"]?.[col] || "");
    const contrastBiasWelt = parseOptionValue(rowData["Contrast Bias Welt"]?.[col] || "");

    // Back fill options (separate from cushion options)
    const fiberBack = parseOptionValue(rowData["Fiber Back"]?.[col] || "");
    const comfortDownBack = parseOptionValue(rowData["Comfort Down Back"]?.[col] || "");
    const legacyDownBack = parseOptionValue(rowData["Legacy Down Back"]?.[col] || "");
    const extraFullBack = parseOptionValue(rowData["Extra Full Back"]?.[col] || "");

    products.push({
      styleNumber: styleNumber.trim(),
      description: description.trim(),
      styleName: styleName.trim(),
      leatherStyleNumber: rowData["LEATHER STYLE"]?.[col]?.trim() || null,
      finish: null,
      decorativeFinishSurcharge: premFinish.surcharge,
      decorativeFinishIsStandard: premFinish.isStandard,
      standardPillows: null,
      gradeRiser: fabricRiser,
      standardSeat: null,
      standardBack: backStyle,
      springDownBdbSurcharge: springDown.surcharge,
      springDownBdbIsStandard: springDown.isStandard,
      comfortDownBdbSurcharge: comfortDown.surcharge,
      comfortDownBdbIsStandard: comfortDown.isStandard,
      harmonySurcharge: harmony.surcharge,
      harmonyIsStandard: harmony.isStandard,
      contrastWeltSurcharge: contrastWelt.surcharge,
      contrastWeltIsStandard: contrastWelt.isStandard,
      contrastBiasWeltSurcharge: contrastBiasWelt.surcharge,
      contrastBiasWeltIsStandard: contrastBiasWelt.isStandard,
      fiberBackSurcharge: fiberBack.surcharge,
      fiberBackIsStandard: fiberBack.isStandard,
      comfortDownBackSurcharge: comfortDownBack.surcharge,
      comfortDownBackIsStandard: comfortDownBack.isStandard,
      legacyDownBackSurcharge: legacyDownBack.surcharge,
      legacyDownBackIsStandard: legacyDownBack.isStandard,
      extraFullBackSurcharge: extraFullBack.surcharge,
      extraFullBackIsStandard: extraFullBack.isStandard,
      yardagePlain: yardage,
      yardagePattern: parseOptionalNumber(yardagePatternStr),
      yardageRepeat: parseOptionalNumber(yardageRepeatStr),
      nailheadSurcharge: nailhead.surcharge,
      nailheadIsStandard: nailhead.isStandard,
      gradePrices,
      overallWidth: dims.width,
      overallDepth: dims.depth,
      overallHeight: dims.height,
      seatHeight: dims.seatHeight,
      armHeight: dims.armHeight,
      seatDepth: dims.seatDepth,
      pageNumber: 0,
    });
  }

  return products;
}

// ─── Parse a single Simplicity pricing page ──────────────────────

function parseSimplicityPageChunk(chunk: string): ParsedFoundationsProduct[] {
  const lines = chunk.split("\n").map((l) => l.trimEnd());

  const rowData: Record<string, string[]> = {};
  let numCols = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Skip page footer
    if (/^\d+\s+(Wholesale|Simplicity)/i.test(line)) continue;

    if (line.startsWith("NAME\t")) {
      rowData["NAME"] = splitTabs(line, "NAME");
      numCols = rowData["NAME"].length;
      continue;
    }

    if (line.startsWith("STYLE NO.\t")) {
      rowData["STYLE NO."] = splitTabs(line, "STYLE NO.");
      continue;
    }

    if (line.startsWith("Description\t")) {
      rowData["Description"] = splitTabs(line, "Description");
      continue;
    }

    // Simplicity uses grades A, B, C — use grade A as the base price
    // Note: "PRICING BY GRADE" header may precede these rows
    if (line.startsWith("A\t")) {
      rowData["A"] = splitTabs(line, "A");
      continue;
    }
    if (line.startsWith("B\t")) {
      rowData["B"] = splitTabs(line, "B");
      continue;
    }
    // B sometimes on its own line (PDF rendering artifact) with values on next line
    if (/^B$/.test(line.trim())) {
      const nextLine = findNextDataLineRaw(lines, i);
      if (nextLine && /^\d/.test(nextLine)) {
        rowData["B"] = nextLine.split("\t").map((v) => v.trim());
      }
      continue;
    }
    if (line.startsWith("C\t")) {
      rowData["C"] = splitTabs(line, "C");
      continue;
    }

    // Cushion options for per-product surcharges
    if (/Hamilton Spring Down\t/.test(line)) {
      rowData["Hamilton Spring Down"] = splitTabsAfterFirst(line);
      continue;
    }
    if (/Comfort Down\s*\t/.test(line) && !line.includes("BACK")) {
      rowData["Comfort Down"] = splitTabsAfterFirst(line);
      continue;
    }

    // Decorative finish
    if (line.startsWith("Prem Finish Upcharge")) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        rowData["Prem Finish"] = line
          .substring(tabIdx + 1)
          .split("\t")
          .map((v) => v.trim());
      }
      continue;
    }
  }

  const styleNumbers = rowData["STYLE NO."] || [];
  if (numCols === 0) numCols = styleNumbers.length;
  if (numCols === 0) return [];

  const products: ParsedFoundationsProduct[] = [];

  for (let col = 0; col < numCols; col++) {
    const styleNumber = styleNumbers[col] || "";
    if (!styleNumber || styleNumber === "-") continue;

    // Use Grade A as the Simplicity price
    const priceStr = rowData["A"]?.[col] || "";
    const cost = parseCurrency(priceStr);
    if (isNaN(cost) || cost <= 0) continue;

    const description = rowData["Description"]?.[col] || "";
    const styleName = rowData["NAME"]?.[col] || "";

    const springDown = parseOptionValue(rowData["Hamilton Spring Down"]?.[col] || "");
    const comfortDown = parseOptionValue(rowData["Comfort Down"]?.[col] || "");
    const premFinish = parseOptionValue(rowData["Prem Finish"]?.[col] || "");
    const nailhead = parseOptionValue(rowData["StdNail"]?.[col] || "");

    products.push({
      styleNumber: styleNumber.trim(),
      description: description.trim(),
      styleName: styleName.trim(),
      foundationsCost: cost,
      standardSeat: null,
      standardBack: null,
      springDownSeatSurcharge: springDown.surcharge,
      springDownSeatIsStandard: springDown.isStandard,
      cdcSeatBdbBackSurcharge: comfortDown.surcharge,
      cdcSeatBdbBackIsStandard: comfortDown.isStandard,
      decorativeFinishSurcharge: premFinish.surcharge,
      decorativeFinishIsStandard: premFinish.isStandard,
      ringBaseSwivel: null,
      nailheadTrim: null,
      nailheadSurcharge: nailhead.surcharge,
      nailheadIsStandard: nailhead.isStandard,
    });
  }

  return products;
}

// ─── Merge products across pages ─────────────────────────────────

/**
 * Merge products with the same style number that appear on multiple pages.
 * This handles multi-page grade splits (fabric grades 7-25 on page 1,
 * leather section on page 2, etc.)
 */
function mergeProducts(products: ParsedWholesaleProduct[]): ParsedWholesaleProduct[] {
  const map = new Map<string, ParsedWholesaleProduct>();

  for (const p of products) {
    const existing = map.get(p.styleNumber);
    if (!existing) {
      map.set(p.styleNumber, { ...p });
    } else {
      // Merge grade prices (add any new grades not in existing)
      const existingGrades = new Set(existing.gradePrices.map((gp) => gp.grade));
      for (const gp of p.gradePrices) {
        if (!existingGrades.has(gp.grade)) {
          existing.gradePrices.push(gp);
        }
      }
      // Merge scalar fields (prefer non-null)
      existing.leatherStyleNumber = existing.leatherStyleNumber || p.leatherStyleNumber;
      existing.standardBack = existing.standardBack || p.standardBack;
      existing.yardagePlain = existing.yardagePlain ?? p.yardagePlain;
      existing.yardagePattern = existing.yardagePattern ?? p.yardagePattern;
      existing.yardageRepeat = existing.yardageRepeat ?? p.yardageRepeat;
      existing.gradeRiser = existing.gradeRiser ?? p.gradeRiser;
      existing.overallWidth = existing.overallWidth ?? p.overallWidth;
      existing.overallDepth = existing.overallDepth ?? p.overallDepth;
      existing.overallHeight = existing.overallHeight ?? p.overallHeight;
      existing.seatHeight = existing.seatHeight ?? p.seatHeight;
      existing.armHeight = existing.armHeight ?? p.armHeight;
      existing.seatDepth = existing.seatDepth ?? p.seatDepth;
      existing.springDownBdbSurcharge = existing.springDownBdbSurcharge ?? p.springDownBdbSurcharge;
      existing.springDownBdbIsStandard =
        existing.springDownBdbIsStandard || p.springDownBdbIsStandard;
      existing.comfortDownBdbSurcharge =
        existing.comfortDownBdbSurcharge ?? p.comfortDownBdbSurcharge;
      existing.comfortDownBdbIsStandard =
        existing.comfortDownBdbIsStandard || p.comfortDownBdbIsStandard;
      existing.harmonySurcharge = existing.harmonySurcharge ?? p.harmonySurcharge;
      existing.harmonyIsStandard = existing.harmonyIsStandard || p.harmonyIsStandard;
      existing.decorativeFinishSurcharge =
        existing.decorativeFinishSurcharge ?? p.decorativeFinishSurcharge;
      existing.decorativeFinishIsStandard =
        existing.decorativeFinishIsStandard || p.decorativeFinishIsStandard;
      existing.nailheadSurcharge = existing.nailheadSurcharge ?? p.nailheadSurcharge;
      existing.nailheadIsStandard = existing.nailheadIsStandard || p.nailheadIsStandard;
      existing.contrastWeltSurcharge = existing.contrastWeltSurcharge ?? p.contrastWeltSurcharge;
      existing.contrastWeltIsStandard = existing.contrastWeltIsStandard || p.contrastWeltIsStandard;
      existing.contrastBiasWeltSurcharge =
        existing.contrastBiasWeltSurcharge ?? p.contrastBiasWeltSurcharge;
      existing.contrastBiasWeltIsStandard =
        existing.contrastBiasWeltIsStandard || p.contrastBiasWeltIsStandard;
      existing.fiberBackSurcharge = existing.fiberBackSurcharge ?? p.fiberBackSurcharge;
      existing.fiberBackIsStandard = existing.fiberBackIsStandard || p.fiberBackIsStandard;
      existing.comfortDownBackSurcharge =
        existing.comfortDownBackSurcharge ?? p.comfortDownBackSurcharge;
      existing.comfortDownBackIsStandard =
        existing.comfortDownBackIsStandard || p.comfortDownBackIsStandard;
      existing.legacyDownBackSurcharge =
        existing.legacyDownBackSurcharge ?? p.legacyDownBackSurcharge;
      existing.legacyDownBackIsStandard =
        existing.legacyDownBackIsStandard || p.legacyDownBackIsStandard;
      existing.extraFullBackSurcharge = existing.extraFullBackSurcharge ?? p.extraFullBackSurcharge;
      existing.extraFullBackIsStandard =
        existing.extraFullBackIsStandard || p.extraFullBackIsStandard;
      existing.pageNumber = existing.pageNumber ?? p.pageNumber;
    }
  }

  return Array.from(map.values());
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Split a line on tabs and return all values after the first cell (the label).
 */
function splitTabsAfterFirst(line: string): string[] {
  const parts = line.split("\t").map((v) => v.trim());
  return parts.slice(1);
}

// ─── Concatenated value tokenizer ────────────────────────────────
//
// The PDF renderer sometimes smashes per-column option values into a
// single string without tab separators (e.g. "n/cn/c----" instead of
// six tab-separated cells). This tokenizer splits those blobs into
// individual values using known token patterns.

/**
 * Split a contiguous run of digits into 2- or 3-digit numeric tokens.
 * Uses numCols context: tries 2-digit chunks first (most common in
 * CR Laine pricing), falls back to 3-digit if 2-digit produces too
 * many tokens for the remaining column slots.
 */
function splitDigitRun(digits: string, maxTokens: number): string[] {
  const len = digits.length;
  if (len <= 3) return [digits];

  // Try 2-digit split (covers 10-99 range, most CR Laine surcharges)
  if (len % 2 === 0) {
    const tokens: string[] = [];
    for (let i = 0; i < len; i += 2) tokens.push(digits.substring(i, i + 2));
    if (tokens.length <= maxTokens) return tokens;
  }

  // Try 3-digit split (covers 100+ values like 105, 135)
  if (len % 3 === 0) {
    const tokens: string[] = [];
    for (let i = 0; i < len; i += 3) tokens.push(digits.substring(i, i + 3));
    if (tokens.length <= maxTokens) return tokens;
  }

  return [digits];
}

/**
 * Tokenize a concatenated option-value blob into individual cell values.
 * Recognized tokens: "Std Small", "Std Medium", "Poly/Dacron",
 * "Poly/Fiber", "n/c", "Std", numeric (2-3 digits), "-".
 */
function tokenizeConcatenated(blob: string, numCols: number): string[] {
  const tokens: string[] = [];
  let pos = 0;
  const s = blob;

  // Multi-char tokens, ordered longest-first to avoid partial matches
  const stringTokens = ["Std Small", "Std Medium", "Poly/Dacron", "Poly/Fiber", "n/c", "Std"];

  while (pos < s.length && tokens.length < numCols) {
    // Skip whitespace between values
    while (pos < s.length && s[pos] === " ") pos++;
    if (pos >= s.length) break;

    // Try known string tokens
    let matched = false;
    for (const tok of stringTokens) {
      if (s.substring(pos, pos + tok.length) === tok) {
        tokens.push(tok);
        pos += tok.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Dash (not available)
    if (s[pos] === "-") {
      tokens.push("-");
      pos++;
      continue;
    }

    // Digit run — collect all consecutive digits, then split
    if (s[pos] >= "0" && s[pos] <= "9") {
      let numStr = "";
      while (pos < s.length && s[pos] >= "0" && s[pos] <= "9") {
        numStr += s[pos];
        pos++;
      }
      const remaining = numCols - tokens.length;
      tokens.push(...splitDigitRun(numStr, remaining));
      continue;
    }

    // Unknown character — skip
    pos++;
  }

  while (tokens.length < numCols) tokens.push("-");
  return tokens.slice(0, numCols);
}

/**
 * Extract per-product option values from a PDF row. Handles both
 * tab-separated (clean extraction) and concatenated (smashed columns)
 * rendering. Falls back to tokenization when tab splitting produces
 * fewer values than expected.
 */
function splitOptionValues(line: string, numCols: number): string[] {
  const tabIdx = line.indexOf("\t");
  if (tabIdx < 0) return Array(numCols).fill("-");

  const valueStr = line.substring(tabIdx + 1);
  const tabParts = valueStr.split("\t").map((v) => v.trim());

  if (tabParts.length >= numCols) return tabParts.slice(0, numCols);

  // Tabs gave too few values — columns are concatenated
  const joined = tabParts.join("");
  return tokenizeConcatenated(joined, numCols);
}

/**
 * Find the next non-empty line (raw, no label filtering).
 */
function findNextDataLineRaw(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex + 1; j < Math.min(lines.length, fromIndex + 3); j++) {
    const l = lines[j].trim();
    if (l) return l;
  }
  return null;
}

/**
 * Find the previous non-empty data line (looking backward, skip labels).
 */
function findPrevDataLine(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex - 1; j >= Math.max(0, fromIndex - 3); j--) {
    const l = lines[j].trim();
    if (l && l.includes("\t") && !isCrLaineLabelLine(l)) return l;
  }
  return null;
}

function isCrLaineLabelLine(line: string): boolean {
  const labels = [
    "NAME",
    "STYLE NO.",
    "Description",
    "Dimension",
    "Weight",
    "Skirt",
    "Back Style",
    "Contrast",
    "Prem Finish",
    "StdNail",
    "Standard TP",
    "Cont TP",
    "COM Yardage",
    "Hallmark",
    "Mayfair",
    "OPTIONS",
    "CUSHION",
    "BACK",
    "Harmony",
    "Hamilton",
    "Fiber",
    "Comfort Down",
    "Legacy Down",
    "Extra Full",
    "PRICING",
    "LEATHER",
    "COL",
    "Add for",
    "7/COM",
  ];
  const trimmed = line.trim();
  return labels.some((l) => trimmed.startsWith(l));
}

function parseOptionalNumber(val: any): number | null {
  if (!val) return null;
  const s = String(val).trim();
  if (s === "-" || s === "--" || s === "------" || s === "Std" || s === "n/c" || s === "")
    return null;
  const num = parseCurrency(s);
  return isNaN(num) ? null : num;
}

/**
 * Parse an option value that may be "Std" (standard/included at no extra charge),
 * a dollar amount (surcharge), or empty/dash (not available).
 */
interface OptionParseResult {
  surcharge: number | null;
  isStandard: boolean;
}

function parseOptionValue(val: any): OptionParseResult {
  if (!val) return { surcharge: null, isStandard: false };
  const s = String(val).trim();
  if (s === "Std" || s === "n/c") return { surcharge: 0, isStandard: true };
  if (s === "-" || s === "--" || s === "------" || s === "")
    return { surcharge: null, isStandard: false };
  const num = parseCurrency(s);
  return isNaN(num)
    ? { surcharge: null, isStandard: false }
    : { surcharge: num, isStandard: false };
}
