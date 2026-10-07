// /app/src/lib/pricing/summerClassicsParser.ts
//
// PDF parser for Summer Classics wholesale price lists.
// Extracts cushioned products (graded A/B/C/D by fabric) and
// frame-only products (flat price) organized by collection.

import { extractPdfTextWithPages } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";

// ─── Exported types ──────────────────────────────────────────────

export interface ParsedSCProduct {
  styleNumber: string;
  frameNumber: string;
  description: string;
  collection: string;
  cushionType: string | null;
  dimensions: string | null;
  weight: number | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  framePrice: number;
  gradePrices: { grade: string; cost: number }[];
  cushionOnlyPrices: { grade: string; cost: number }[];
  stockCode: string | null;
  pageNumber: number;
}

export interface ParsedSCCollection {
  name: string;
  availableFinishes: string;
}

export interface ParsedSCData {
  products: ParsedSCProduct[];
  collections: ParsedSCCollection[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Title-case a collection name: "CLUB TEAK" → "Club Teak" */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(?:^|\s|[-/])\w/g, (ch) => ch.toUpperCase());
}

/** Parse dimension string into W/D/H. Handles formats like "31.5'H x 33.5'W x 33.5'D" */
function parseDimensions(dims: string): {
  width: number | null;
  depth: number | null;
  height: number | null;
} {
  const result = {
    width: null as number | null,
    depth: null as number | null,
    height: null as number | null,
  };
  const hMatch = dims.match(/([\d.]+)['"]*\s*H/i);
  const wMatch = dims.match(/([\d.]+)['"]*\s*W/i);
  const dMatch = dims.match(/([\d.]+)['"]*\s*D/i);
  if (hMatch) result.height = Number.parseFloat(hMatch[1]);
  if (wMatch) result.width = Number.parseFloat(wMatch[1]);
  if (dMatch) result.depth = Number.parseFloat(dMatch[1]);
  return result;
}

/** Extract weight from text containing "WT: XX lbs" */
function parseWeight(text: string): number | null {
  const m = text.match(/WT:\s*([\d.]+)\s*lbs/i);
  return m ? Number.parseFloat(m[1]) : null;
}

/** Extract raw dimension string (everything before "WT:" or "Frame:") */
function extractDimensionStr(text: string): string | null {
  const m = text.match(
    /([\d.']+\s*['"]?\s*H\s*x\s*[\d.']+\s*['"]?\s*W?\s*x?\s*[\d.'"+\s*]*['"]*\s*[WD]?)/i,
  );
  if (m) return m[0].trim();
  return null;
}

/**
 * Check if a line looks like a product header: contains a frame number,
 * product name, and "Frame:" price.
 *
 * Returns parsed header data or null.
 */
function parseProductHeader(line: string): {
  styleCode: string | null;
  frameNumber: string;
  description: string;
  dimensions: string | null;
  weight: number | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  framePrice: number;
} | null {
  // Must have "Frame:" followed by a price
  const frameMatch = line.match(/Frame:\s*\$?([\d,]+)/);
  if (!frameMatch) return null;
  const framePrice = parseCurrency(frameMatch[1]);
  if (isNaN(framePrice)) return null;

  const parts = line
    .split("\t")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  // First part(s): optional style code + frame number
  // Patterns:
  //   "C640\t2844 + Finish\tCLUB TEAK..."
  //   "2855 + Finish\tCLUB TEAK END TABLE..."
  //   "27474\tCOAST TEAK EXTENSION TABLE..."
  //   "1558142\tTAHOE LOUNGE CHAIR..."
  let styleCode: string | null = null;
  let frameNumber = "";
  let descStart = 1;

  // Check if first part is a style code (starts with letter, like C640 or E028)
  if (/^[A-Z]\d{2,}/i.test(parts[0]) && parts.length >= 3) {
    styleCode = parts[0];
    // Second part is the frame number (may have "+ Finish" suffix)
    frameNumber = parts[1].replace(/\s*\+\s*Finish$/i, "").trim();
    descStart = 2;
  } else {
    // First part is the frame number
    frameNumber = parts[0].replace(/\s*\+\s*Finish$/i, "").trim();
    descStart = 1;
  }

  // Must have a numeric frame number (allow alphanumeric like "1558142")
  if (!/^\d/.test(frameNumber) && !/^[A-Z]\d/i.test(frameNumber)) return null;

  // Build description from remaining parts before the dimension/weight/price info
  const descParts: string[] = [];
  let dimStr: string | null = null;
  let weight: number | null = null;

  for (let i = descStart; i < parts.length; i++) {
    const part = parts[i];
    if (/Frame:\s*\$?[\d,]/.test(part)) break;
    if (/\d+['"]?\s*H\s*x\s/i.test(part) || /WT:\s*[\d.]+/i.test(part)) {
      // This part contains dimensions/weight
      dimStr = extractDimensionStr(part);
      weight = parseWeight(part);
      break;
    }
    descParts.push(part);
  }

  const description = descParts.join(" ").trim();
  if (!description) return null;

  const dims = dimStr ? parseDimensions(dimStr) : { width: null, depth: null, height: null };

  return {
    styleCode,
    frameNumber,
    description,
    dimensions: dimStr,
    weight,
    ...dims,
    framePrice,
  };
}

/**
 * Parse a cushion variant line.
 * Expected format: "CODE\tType Name\tStock Code Template\t$A\t$B\t$C\t$D\t$A\t$B\t$C\t$D"
 * The first 4 prices are "Cushion Only", the second 4 are "Frame with Cushion".
 */
function parseCushionVariantLine(line: string): {
  variantCode: string;
  cushionType: string;
  stockCode: string | null;
  cushionOnly: number[];
  frameWithCushion: number[];
} | null {
  const parts = line
    .split("\t")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 5) return null;

  const variantCode = parts[0];
  // Variant code should start with a letter or be alphanumeric (C640, C640P, E028H, etc.)
  if (!/^[A-Z]/i.test(variantCode)) return null;

  // Find all dollar values in the line
  const prices: number[] = [];
  let cushionType = "";
  let stockCode: string | null = null;

  for (let i = 1; i < parts.length; i++) {
    const val = parseCurrency(parts[i]);
    if (!isNaN(val)) {
      prices.push(val);
    } else if (prices.length === 0) {
      // Before any prices: part of the type name or stock code
      if (parts[i].includes("Fabric") || parts[i].includes("+")) {
        stockCode = parts[i];
      } else if (!cushionType) {
        cushionType = parts[i];
      } else {
        // Additional type name parts or stock code
        if (parts[i].includes("+") || parts[i].includes("#")) {
          stockCode = (stockCode ? stockCode + " " : "") + parts[i];
        } else {
          cushionType += " " + parts[i];
        }
      }
    }
  }

  // Need at least 4 prices (could be 4 cushion-only + 4 frame-with-cushion = 8,
  // or just 4 frame-with-cushion if cushion-only columns merge)
  if (prices.length < 4) return null;

  let cushionOnly: number[];
  let frameWithCushion: number[];
  if (prices.length >= 8) {
    cushionOnly = prices.slice(0, 4);
    frameWithCushion = prices.slice(4, 8);
  } else {
    // Fewer than 8 prices -- treat all as frame-with-cushion
    cushionOnly = [];
    frameWithCushion = prices.slice(0, 4);
  }

  if (!cushionType) cushionType = "Standard";

  return {
    variantCode,
    cushionType: cushionType.trim(),
    stockCode,
    cushionOnly,
    frameWithCushion,
  };
}

/**
 * Check if a line is a collection header. Collection headers are all-caps names
 * that appear at the start of a page section, NOT matching product patterns.
 */
function isCollectionHeader(line: string): boolean {
  const trimmed = line.trim();
  // Must be all-caps, no digits at start, no "$", not a known non-collection header
  if (!trimmed || trimmed.length < 3 || trimmed.length > 80) return false;
  if (/^\d/.test(trimmed)) return false;
  if (trimmed.includes("$")) return false;
  if (
    /^(SC Price List|Please note|should be entered|Prices effective|Pricing is subject)/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (/^(Cushion Options|Type|Stock Code|Cushion Only|Frame with Cushion)/i.test(trimmed))
    return false;
  if (
    /^(Standard|Dream|Firm|Reticulated|Savann)/i.test(trimmed) &&
    /Welt|Cushion|Bench/i.test(trimmed)
  ) {
    return false;
  }
  // All uppercase letters, spaces, hyphens, slashes, and parentheses
  if (/^[A-Z\s\-/()'+.&]+$/.test(trimmed) && /[A-Z]{2,}/.test(trimmed)) return true;
  return false;
}

/** Check if a line is an "AVAILABLE IN" line with finish codes */
function isAvailableLine(line: string): boolean {
  return /^AVAILABLE IN\s/i.test(line.trim());
}

// ─── Skip patterns ───────────────────────────────────────────────

const SKIP_LINE_PATTERNS = [
  /^SC Price List/i,
  /^Please note that/i,
  /^should be entered/i,
  /^Prices effective/i,
  /^Pricing is subject/i,
  /^\*PLEASE SEE TABLE/i,
];

function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return SKIP_LINE_PATTERNS.some((p) => p.test(trimmed));
}

// ─── Section headers that act as pseudo-collections ──────────────

const SECTION_HEADERS: Record<string, string> = {
  "TAILORED SLIP COVERED UPHOLSTERY": "Tailored Slip Covered Upholstery",
  LANTERNS: "Lanterns",
  PLANTERS: "Planters",
  "DINING TABLE PROGRAM": "Dining Table Program",
  "PLATEAU TABLE TOPS": "Plateau Table Tops",
  "HORIZON ALUMINUM TABLE TOPS": "Horizon Aluminum Table Tops",
  "CORT COLLECTION WROUGHT ALUMINUM TABLE BASES": "Cort Aluminum Table Bases",
  "WROUGHT ALUMINUM TABLES": "Wrought Aluminum Tables",
  "END TABLES": "End Tables",
  "COFFEE TABLES": "Coffee Tables",
  "ELLA TABLES WITH SUPERSTONE TOPS": "Ella Superstone Tables",
  "HARRIS TABLES": "Harris Tables",
  LAGUNA: "Laguna",
  LAKESHORE: "Lakeshore",
  MADEIRA: "Madeira",
  MESSINA: "Messina",
  "TEAK DINING TABLES": "Teak Dining Tables",
  "CAST STONE TABLES": "Cast Stone Tables",
  "CONSOLES, BAR TABLES, BAR CART": "Consoles & Bar Tables",
  "CHAT GROUPS": "Chat Groups",
  "BAR STOOLS": "Bar Stools",
  CHAISES: "Chaises",
  "GARDEN BENCHES": "Garden Benches",
};

// ─── Main parser ─────────────────────────────────────────────────

export async function parseSummerClassicsWholesale(buffer: Buffer): Promise<ParsedSCData> {
  const raw = await extractPdfTextWithPages(buffer);
  const lines = raw.split("\n");

  const products: ParsedSCProduct[] = [];
  const collectionMap = new Map<string, string>(); // name → availableFinishes

  let currentCollection = "Uncategorized";
  let currentPage = 1;

  // State for multi-line product parsing
  let pendingHeader: ReturnType<typeof parseProductHeader> = null;
  let inCushionBlock = false;

  function flushPendingFrameOnly() {
    if (!pendingHeader) return;
    // Emit as frame-only product
    products.push({
      styleNumber: pendingHeader.frameNumber,
      frameNumber: pendingHeader.frameNumber,
      description: pendingHeader.description,
      collection: currentCollection,
      cushionType: null,
      dimensions: pendingHeader.dimensions,
      weight: pendingHeader.weight,
      width: pendingHeader.width,
      depth: pendingHeader.depth,
      height: pendingHeader.height,
      framePrice: pendingHeader.framePrice,
      gradePrices: [],
      cushionOnlyPrices: [],
      stockCode: null,
      pageNumber: currentPage,
    });
    pendingHeader = null;
    inCushionBlock = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track page numbers
    const pageMatch = line.match(/<<PAGE:(\d+)>>/);
    if (pageMatch) {
      currentPage = Number.parseInt(pageMatch[1]);
      continue;
    }

    if (shouldSkipLine(line)) continue;
    const trimmed = line.trim();

    // Check for section headers (pseudo-collections)
    const normalizedUpper = trimmed.replace(/[\t ]+/g, " ").toUpperCase();
    const sectionName = SECTION_HEADERS[normalizedUpper];
    if (sectionName) {
      flushPendingFrameOnly();
      currentCollection = sectionName;
      if (!collectionMap.has(currentCollection)) {
        collectionMap.set(currentCollection, "");
      }
      continue;
    }

    // Check for "AVAILABLE IN" line (finish availability for current collection)
    if (isAvailableLine(trimmed)) {
      // Accumulate multi-line availability text
      let availText = trimmed.replace(/^AVAILABLE IN\s*/i, "").trim();
      // Check next lines for continuation (lines starting with # or continuing the list)
      while (i + 1 < lines.length) {
        const nextTrimmed = lines[i + 1].trim();
        if (
          nextTrimmed.startsWith("#") ||
          nextTrimmed.startsWith(",") ||
          nextTrimmed.startsWith("AND ")
        ) {
          availText += " " + nextTrimmed;
          i++;
        } else {
          break;
        }
      }
      if (collectionMap.has(currentCollection)) {
        collectionMap.set(currentCollection, availText);
      }
      continue;
    }

    // Check for collection header
    if (isCollectionHeader(trimmed) && !trimmed.includes("\t")) {
      // Look ahead for "AVAILABLE IN" to confirm it's a collection
      const nextNonEmpty = findNextNonEmpty(lines, i);
      if (nextNonEmpty && isAvailableLine(nextNonEmpty)) {
        flushPendingFrameOnly();
        currentCollection = titleCase(trimmed);
        if (!collectionMap.has(currentCollection)) {
          collectionMap.set(currentCollection, "");
        }
        continue;
      }
      // Some section headers (late pages) don't have AVAILABLE IN.
      // Check if it matches known sections.
      const upperNorm = trimmed.replace(/\s+/g, " ").toUpperCase();
      if (SECTION_HEADERS[upperNorm]) {
        flushPendingFrameOnly();
        currentCollection = SECTION_HEADERS[upperNorm];
        if (!collectionMap.has(currentCollection)) {
          collectionMap.set(currentCollection, "");
        }
        continue;
      }
      // Could be a sub-collection that has products directly below (e.g., collections
      // in later pages like Chat Groups that repeat collection names).
      // Check if next relevant line is a product header.
      if (nextNonEmpty) {
        const nextHeader = parseProductHeader(nextNonEmpty);
        if (nextHeader || isCollectionLikeHeader(trimmed)) {
          flushPendingFrameOnly();
          currentCollection = titleCase(trimmed);
          if (!collectionMap.has(currentCollection)) {
            collectionMap.set(currentCollection, "");
          }
          continue;
        }
      }
    }

    // Check for "Cushion Options" marker
    if (/^Cushion Options/i.test(trimmed.replace(/\t/g, " "))) {
      inCushionBlock = true;
      continue;
    }

    // Skip header rows within cushion blocks
    if (inCushionBlock && /^Type\b/i.test(trimmed.replace(/\t/g, " "))) continue;
    if (/^(Cushion Only|Frame with Cushion)/i.test(trimmed.replace(/\t/g, " "))) continue;
    if (/^(A\tB\tC\tD)/i.test(trimmed) || /^\tA\tB\tC\tD/.test(line)) continue;

    // Try parsing as cushion variant line
    if (inCushionBlock && pendingHeader) {
      const variant = parseCushionVariantLine(trimmed);
      if (variant) {
        const gradePrices = variant.frameWithCushion.map((cost, idx) => ({
          grade: ["A", "B", "C", "D"][idx],
          cost,
        }));
        const cushionOnlyPrices = variant.cushionOnly.map((cost, idx) => ({
          grade: ["A", "B", "C", "D"][idx],
          cost,
        }));

        products.push({
          styleNumber: variant.variantCode,
          frameNumber: pendingHeader.frameNumber,
          description: pendingHeader.description,
          collection: currentCollection,
          cushionType: variant.cushionType,
          dimensions: pendingHeader.dimensions,
          weight: pendingHeader.weight,
          width: pendingHeader.width,
          depth: pendingHeader.depth,
          height: pendingHeader.height,
          framePrice: pendingHeader.framePrice,
          gradePrices,
          cushionOnlyPrices,
          stockCode: variant.stockCode,
          pageNumber: currentPage,
        });
        continue;
      }
    }

    // Try parsing as product header
    const header = parseProductHeader(trimmed);
    if (header) {
      // Flush any pending frame-only product before starting a new one
      flushPendingFrameOnly();
      pendingHeader = header;
      inCushionBlock = false;
      continue;
    }

    // If we have a pending header and hit a non-cushion, non-header line,
    // it's likely the end of the cushion block or a frame-only product.
    if (pendingHeader && !inCushionBlock) {
      // Check if the next meaningful content is a cushion block
      const aheadLine = trimmed.replace(/\t/g, " ");
      if (/Cushion Options/i.test(aheadLine)) {
        inCushionBlock = true;
        continue;
      }
      // Not a cushion block starting -- this pending header is frame-only
      flushPendingFrameOnly();
    }

    // If in a cushion block but the line doesn't parse as a variant,
    // the cushion block is over
    if (inCushionBlock && pendingHeader) {
      // Could be a "Optional Headrest Cushion" sub-header or similar
      if (/Optional|Coast Teak Easy|Headrest/i.test(trimmed)) continue;
      // End the cushion block
      pendingHeader = null;
      inCushionBlock = false;
    }
  }

  // Flush final pending product
  flushPendingFrameOnly();

  // Build collections list
  const collections: ParsedSCCollection[] = [];
  collectionMap.forEach((finishes, name) => {
    collections.push({ name, availableFinishes: finishes });
  });

  return { products, collections };
}

// ─── Internal helpers ────────────────────────────────────────────

function findNextNonEmpty(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex + 1; j < Math.min(lines.length, fromIndex + 5); j++) {
    const trimmed = lines[j].trim();
    if (trimmed && !shouldSkipLine(lines[j])) return trimmed;
  }
  return null;
}

function isCollectionLikeHeader(text: string): boolean {
  const upper = text.trim().toUpperCase();
  // Short all-caps text with no digits is likely a collection name
  return upper.length >= 3 && upper.length <= 60 && /^[A-Z\s\-/()'+.&]+$/.test(upper);
}
