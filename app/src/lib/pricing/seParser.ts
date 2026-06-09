// /app/src/lib/pricing/seParser.ts
//
// Server-only parser for Wesley Hall's Signature Elements pricing tables.
// Separated from wesleyHallParser.ts because it imports pdf-parse (Node fs),
// and wesleyHallParser is also pulled into client bundles by the import page.

import pdf from "pdf-parse";
import { columnAwarePageRenderer } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";
import type { ParsedSEProduct } from "./wesleyHallParser";

export type { ParsedSEProduct };

// Fixed piece type definitions per table layout. Column headers in the PDF are
// multi-line and unreliable to parse, so we define piece types statically and
// match by column count.

const SE_SOFA_P1 = [
  { name: "XL Sofa", code: "XLS" },
  { name: "Long Sofa", code: "LGS" },
  { name: "Medium Sofa", code: "MDS" },
  { name: "Apartment Sofa", code: "APS" },
  { name: "Loveseat", code: "LVS" },
  { name: "RAF/LAF Corner Sofa", code: "CRS" },
  { name: "RAF/LAF One Arm Sofa", code: "OAS" },
  { name: "Armless Sofa", code: "ARS" },
];

const SE_SOFA_P2 = [
  { name: "RAF/LAF One Arm Loveseat", code: "OAL" },
  { name: "Armless Loveseat", code: "ARL" },
  { name: "Curve", code: "CRV" },
  { name: "Corner Chair", code: "CCH" },
  { name: "RAF/LAF Chaise", code: "CHS" },
  { name: "Armless Chair", code: "ACH" },
  { name: "Sectional Ottoman", code: "SOT" },
];

const SE_CHAIRS = [
  { name: "Chair & Half", code: "C15" },
  { name: "Chair & Half Matching Ottoman", code: "CMO" },
  { name: "Chair", code: "CHR" },
  { name: "Matching Ottoman", code: "MOT" },
  { name: "Full Sleeper", code: "FSL" },
  { name: "Queen Sleeper", code: "QSL" },
];

/**
 * Extract Signature Elements pricing from a Wesley Hall wholesale PDF.
 * Returns one ParsedSEProduct per piece-type per material/depth combination.
 */
export async function parseSEPricing(pdfBuffer: Buffer): Promise<ParsedSEProduct[]> {
  const data = await pdf(pdfBuffer, {
    pagerender: (pageData: any) =>
      columnAwarePageRenderer(pageData).then(
        (text: string) => `<<PAGE:${pageData.pageNumber}>>\n${text}`,
      ),
  });

  const allProducts: ParsedSEProduct[] = [];
  const segments = data.text.split(/<<PAGE:(\d+)>>\n/);

  for (let i = 1; i < segments.length; i += 2) {
    const pageText = segments[i + 1] || "";
    if (!pageText.includes("SIGNATURE ELEMENTS")) continue;
    // Skip title/divider pages (they have SE text but no pricing grid)
    if (!pageText.includes("FINISH")) continue;

    const products = parseSETablePage(pageText);
    allProducts.push(...products);
  }

  return allProducts;
}

function parseSETablePage(pageText: string): ParsedSEProduct[] {
  const hasLeather = /LEATHER/i.test(pageText);
  const hasFabric = /FABRIC/i.test(pageText);
  if (!hasFabric && !hasLeather) return [];

  const isFabric = hasFabric && !hasLeather;
  const material: "FABRIC" | "LEATHER" = isFabric ? "FABRIC" : "LEATHER";
  const materialCode = isFabric ? "F" : "L";

  const isChairs = /CHAIRS.*OTTOMANS/i.test(pageText);
  const isExtended = /EXTENDED\s+DEPTH/i.test(pageText);
  const depthCode = isChairs ? "CH" : isExtended ? "24" : "21";
  const depthLabel = isChairs
    ? "Chairs/Ottomans/Sleepers"
    : isExtended
      ? "Extended Depth"
      : "Standard Depth";
  const description = `Signature Elements - ${isFabric ? "Fabric" : "Leather"} - ${depthLabel}`;

  // Count price columns via Decorative Finish row (all values are 100)
  const lines = pageText.split("\n").map((l) => l.trimEnd());
  let detectedCols = 0;
  for (const line of lines) {
    if (/^Decorative Finish\t/.test(line)) {
      detectedCols = line.split("\t").filter((s) => s.trim() === "100").length;
      break;
    }
  }
  if (detectedCols === 0) return [];

  let pieceTypes: { name: string; code: string }[];
  if (isChairs) {
    pieceTypes = SE_CHAIRS;
  } else if (detectedCols >= 8) {
    pieceTypes = SE_SOFA_P1;
  } else {
    pieceTypes = SE_SOFA_P2;
  }
  const numCols = pieceTypes.length;

  // Per-column accumulators
  const gradePrices: { grade: string; cost: number }[][] = Array.from(
    { length: numCols },
    () => [],
  );
  const gradeRiser: (number | null)[] = new Array(numCols).fill(null);
  const stdSeat: (string | null)[] = new Array(numCols).fill(null);
  const stdBack: (string | null)[] = new Array(numCols).fill(null);
  const comfortTight: (number | null)[] = new Array(numCols).fill(null);
  const comfortFilled: (number | null)[] = new Array(numCols).fill(null);
  const springTight: (number | null)[] = new Array(numCols).fill(null);
  const springFilled: (number | null)[] = new Array(numCols).fill(null);

  let cushionSection: "comfort" | "spring" | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;

    // (COM) row: fabric base price
    if (/^\(COM\)\t/.test(line)) {
      const parts = line.split("\t").slice(1);
      addSEGrade(gradePrices, "COM", parts, numCols);
      continue;
    }

    // (COL) standalone row (some leather tables put it alone)
    if (/^\(COL\)\t/.test(line)) {
      const parts = line.split("\t").slice(1);
      addSEGrade(gradePrices, "COL", parts, numCols);
      continue;
    }

    // GRADE + first label: "GRADE\t14\t..." or "GRADE\t(COL)\t..."
    if (/^GRADE\t/.test(line) && !/^GRADE RISER/.test(line)) {
      const parts = line.split("\t").map((s) => s.trim());
      if (parts.length >= 3) {
        let grade = parts[1];
        if (grade === "(COL)") grade = "COL";
        addSEGrade(gradePrices, grade, parts.slice(2), numCols);
      }
      continue;
    }

    // Standalone fabric grades: "15\t2336\t..."
    if (isFabric) {
      const m = line.match(/^(\d{1,2})\t(.+)/);
      if (m) {
        const num = Number.parseInt(m[1]);
        if (num >= 14 && num <= 35) {
          addSEGrade(gradePrices, m[1], m[2].split("\t"), numCols);
          continue;
        }
      }
    }

    // Standalone leather grades: "C\t3170\t..."
    if (!isFabric) {
      const m = line.match(/^([A-Z])\t(.+)/);
      if (m && m[1] >= "C" && m[1] <= "Z") {
        addSEGrade(gradePrices, m[1], m[2].split("\t"), numCols);
        continue;
      }
    }

    // GRADE RISER
    if (/^GRADE RISER\t/.test(line)) {
      const vals = parseSENumericRow(line, numCols);
      for (let c = 0; c < numCols; c++) {
        gradeRiser[c] = vals[c] > 0 ? vals[c] : null;
      }
      continue;
    }

    // STANDARD SEAT
    if (/^STANDARD SEAT\t/.test(line)) {
      const parts = line.split("\t").slice(1);
      for (let c = 0; c < numCols && c < parts.length; c++) {
        stdSeat[c] = parts[c].trim() || null;
      }
      continue;
    }

    // STANDARD BACK
    if (/^STANDARD BACK/.test(line)) {
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        const parts = line.substring(tabIdx + 1).split("\t");
        for (let c = 0; c < numCols && c < parts.length; c++) {
          stdBack[c] = parts[c].trim() || null;
        }
      }
      continue;
    }

    // Cushion section headers
    if (/Comfort\s*Down/i.test(line)) {
      cushionSection = "comfort";
      continue;
    }
    if (/Spring.Down/i.test(line)) {
      cushionSection = "spring";
      continue;
    }

    // Cushion surcharge sub-rows
    if (/Tight\s*Back:/i.test(line) && cushionSection) {
      const vals = parseSENumericRow(line, numCols);
      const target = cushionSection === "comfort" ? comfortTight : springTight;
      for (let c = 0; c < numCols; c++) {
        target[c] = vals[c] > 0 ? vals[c] : null;
      }
      continue;
    }
    if (/Filled\s*Back:/i.test(line) && cushionSection) {
      const vals = parseSENumericRow(line, numCols);
      const target = cushionSection === "comfort" ? comfortFilled : springFilled;
      for (let c = 0; c < numCols; c++) {
        target[c] = vals[c] > 0 ? vals[c] : null;
      }
      continue;
    }
  }

  return pieceTypes
    .map((pt, c) => ({
      styleNumber: `SE-${materialCode}${depthCode}-${pt.code}`,
      styleName: pt.name,
      description,
      material,
      depthCode,
      pieceTypeCode: pt.code,
      gradePrices: gradePrices[c],
      gradeRiser: gradeRiser[c],
      decorativeFinishSurcharge: 100,
      standardSeat: stdSeat[c],
      standardBack: stdBack[c],
      comfortDownTightBack: comfortTight[c],
      comfortDownFilledBack: comfortFilled[c],
      springDownTightBack: springTight[c],
      springDownFilledBack: springFilled[c],
    }))
    .filter((p) => p.gradePrices.length > 0);
}

/** Add a grade price to each column's accumulator. */
function addSEGrade(
  colPrices: { grade: string; cost: number }[][],
  grade: string,
  priceStrings: string[],
  numCols: number,
): void {
  for (let c = 0; c < numCols && c < priceStrings.length; c++) {
    const cost = parseCurrency(priceStrings[c].trim());
    if (!isNaN(cost) && cost > 0) {
      colPrices[c].push({ grade, cost });
    }
  }
}

/** Extract numeric values from a tab-separated row, skipping leading non-numeric labels. */
function parseSENumericRow(line: string, expectedCount: number): number[] {
  const parts = line.split("\t").map((s) => s.trim());
  const values: number[] = [];

  let startIdx = 0;
  while (startIdx < parts.length && isNaN(parseCurrency(parts[startIdx]))) {
    startIdx++;
  }

  for (let i = startIdx; i < parts.length && values.length < expectedCount; i++) {
    const num = parseCurrency(parts[i]);
    values.push(isNaN(num) ? 0 : num);
  }

  while (values.length < expectedCount) {
    values.push(0);
  }

  return values;
}
