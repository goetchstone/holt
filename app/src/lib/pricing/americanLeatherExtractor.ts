// /app/src/lib/pricing/americanLeatherExtractor.ts
//
// Server-only PDF parser for American Leather retail and wholesale price lists.
// Uses pdf-parse with columnAwarePageRenderer to extract tabular pricing data.
//
// American Leather PDFs have a consistent per-page layout:
//   Header: collection name, program type, standard features, options
//   Table:  Description | Frame | C.O.M. Usage | C | D/F | G | H | J | I | II | III | V
//
// This file imports pdf-parse (Node fs dependency) and must only be imported
// from API routes, never from client-side code.

import pdf from "pdf-parse";
import { columnAwarePageRenderer } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";

// ─── Types ────────────────────────────────────────────────────────

export interface ALParsedProduct {
  collectionName: string;
  programType: string;
  description: string;
  frameNumber: string;
  comUsage: number | null;
  gradePrices: { grade: string; cost: number }[];
  pageNumber: number;
}

export interface ALParsedPage {
  collectionName: string;
  programType: string;
  optionsText: string;
  standardFeaturesText: string;
  products: ALParsedProduct[];
  pageNumber: number;
}

export interface ALExtractionResult {
  pages: ALParsedPage[];
  products: ALParsedProduct[];
  effectiveDate: string | null;
  isRetail: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

// Grade column codes in the order they appear in the PDF table.
// Leather: C, D/F, G, H, J  |  Fabric: I, II, III, V
const LEATHER_GRADE_CODES = ["C", "D/F", "G", "H", "J"];
const FABRIC_GRADE_CODES = ["I", "II", "III", "V"];
const ALL_GRADE_CODES = [...LEATHER_GRADE_CODES, ...FABRIC_GRADE_CODES];

// Frame number pattern: 3 uppercase letters, dash, 2-4 alphanumeric, dash, 2 alphanumeric
// Examples: BNY-SR2-QS, AOR-SO3-KS, TEN-CR1-TS, LNR-CHR-ST, VRS-C2L-LA
const FRAME_PATTERN = /^[A-Z]{3}-[A-Z0-9]{2,4}-[A-Z0-9]{2,3}$/;

// Program type patterns detected from the PDF header area.
const PROGRAM_PATTERNS: [RegExp, string][] = [
  [/comfort\s+sleeper\s+collection/i, "Comfort Sleeper"],
  [/silver\s+sleeper/i, "Silver Sleeper"],
  [/today\s+sleeper/i, "Today Sleeper"],
  [/style\s+in\s+motion.*?-\s*a\s+series/i, "Style In Motion A"],
  [/style\s+in\s+motion.*?-\s*i\s+series/i, "Style In Motion I"],
  [/style\s+in\s+motion.*?-\s*l\s+series/i, "Style In Motion L"],
  [/style\s+in\s+motion.*?-\s*m\s+series/i, "Style In Motion M"],
  [/style\s+in\s+motion/i, "Style In Motion"],
  [/re-invented\s+recliner/i, "Re-Invented Recliner"],
  [/recliner\s+program/i, "Recliner Program"],
  [/comfort\s+air\s+echo/i, "Comfort Air Echo"],
  [/comfort\s+air/i, "Comfort Air"],
  [/comfort\s+solace/i, "Comfort Solace"],
  [/comfort\s+relax/i, "Comfort Relax"],
  [/personalize/i, "Personalize"],
  [/american\s+leather/i, "American Leather"],
];

// ─── Main extraction ──────────────────────────────────────────────

export async function extractAmericanLeather(pdfBuffer: Buffer): Promise<ALExtractionResult> {
  const data = await pdf(pdfBuffer, {
    pagerender: (pageData: any) =>
      columnAwarePageRenderer(pageData).then(
        (text: string) => `<<PAGE:${pageData.pageNumber}>>\n${text}`,
      ),
  });

  const fullText = data.text;
  const isRetail = /RETAIL-MRP\s+PRICE\s+LIST/i.test(fullText);

  // Extract effective date from the first page header
  const dateMatch = fullText.match(/EFFECTIVE\s+([\w\s,]+\d{4})/i);
  const effectiveDate = dateMatch ? dateMatch[1].trim() : null;

  const allPages: ALParsedPage[] = [];
  const allProducts: ALParsedProduct[] = [];

  // Split by page markers
  const segments = fullText.split(/<<PAGE:(\d+)>>\n/);

  for (let i = 1; i < segments.length; i += 2) {
    const pageNumber = Number.parseInt(segments[i], 10);
    const pageText = segments[i + 1] || "";

    const parsed = parsePage(pageText, pageNumber);
    if (parsed && parsed.products.length > 0) {
      allPages.push(parsed);
      allProducts.push(...parsed.products);
    }
  }

  return { pages: allPages, products: allProducts, effectiveDate, isRetail };
}

// ─── Page parsing ─────────────────────────────────────────────────

function parsePage(pageText: string, pageNumber: number): ALParsedPage | null {
  const lines = pageText.split("\n").map((l) => l.trim());

  // Skip table-of-contents pages, blank pages, and cover pages
  if (lines.length < 5) return null;

  // Extract collection name and program type from the header area.
  // The collection name is typically a standalone uppercase word or phrase
  // near the top, and the program type appears just below it.
  const { collectionName, programType } = extractHeaderInfo(lines);
  if (!collectionName) return null;

  // Extract standard features and options text blocks
  const standardFeaturesText = extractStandardFeatures(lines);
  const optionsText = extractOptionsText(lines);

  // Find and parse product rows from the pricing table
  const products = parseProductRows(lines, collectionName, programType, pageNumber);

  return {
    collectionName,
    programType,
    optionsText,
    standardFeaturesText,
    products,
    pageNumber,
  };
}

/**
 * Extract collection name and program type from page header lines.
 *
 * The header area follows a pattern:
 *   Line N:   Collection name (e.g., "BENTLEY")
 *   Line N+1: Program type (e.g., "Comfort Sleeper Collection")
 *   Line N+2: "Spec Sheet" or "Order Worksheet"
 *
 * We scan the first ~30 lines looking for a program type match,
 * then backtrack to find the collection name.
 */
function extractHeaderInfo(lines: string[]): {
  collectionName: string;
  programType: string;
} {
  let collectionName = "";
  let programType = "";

  // Look through the first portion of the page for program type indicators
  const headerLines = lines.slice(0, Math.min(40, lines.length));
  const headerBlock = headerLines.join("\n");

  // Try to find a program type in the header
  for (const [pattern, name] of PROGRAM_PATTERNS) {
    if (pattern.test(headerBlock)) {
      programType = name;
      break;
    }
  }

  // Find the collection name: look for a line that is mostly uppercase letters
  // and appears before/near the program type or "Spec Sheet"
  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i].split("\t")[0].trim();

    // Skip header row, empty lines, and known non-collection text
    if (!line) continue;
    if (/RETAIL-MRP|WHOLESALE|PRICE\s+LIST|MRP\s*\(/i.test(line)) continue;
    if (/EFFECTIVE|STANDARD\s+FEATURES|OPTIONS|PREFERRED/i.test(line)) continue;
    if (/Spec\s+Sheet|Order\s+Worksheet|Description|Frame/i.test(line)) continue;
    if (/Leather|Fabric|C\.O\.M|C\.O\.L|Usage/i.test(line)) continue;

    // Collection name is typically all-caps, 2-20 characters
    if (/^[A-Z][A-Z\s'-]{1,25}$/.test(line) && line.length >= 2) {
      // Skip known program type labels that might be standalone
      if (/^(COMFORT|SILVER|TODAY|STYLE|RE-INVENTED|RECLINER|PERSONALIZE|AMERICAN)$/i.test(line))
        continue;

      collectionName = titleCase(line);
      break;
    }
  }

  return { collectionName, programType };
}

/**
 * Extract the OPTIONS text block from a page.
 * Used for downstream option group detection and surcharge parsing.
 */
function extractOptionsText(lines: string[]): string {
  const optionLines: string[] = [];
  let inOptions = false;

  for (const line of lines) {
    const parts = line.split("\t");
    const text = parts.join(" ").trim();

    if (/^OPTIONS\b/i.test(text)) {
      inOptions = true;
      continue;
    }

    if (inOptions) {
      // Stop at the pricing table header
      if (/^Description\b/i.test(text) || /\bLeather\b.*\bFabric\b/i.test(text)) {
        break;
      }
      if (text) optionLines.push(text);
    }
  }

  return optionLines.join("\n");
}

/**
 * Extract the STANDARD FEATURES text block from a page.
 * This section appears between the page header and the OPTIONS block,
 * describing what comes standard with each item on the page.
 */
function extractStandardFeatures(lines: string[]): string {
  const featureLines: string[] = [];
  let inFeatures = false;

  for (const line of lines) {
    const parts = line.split("\t");
    const text = parts.join(" ").trim();

    if (/^STANDARD\s+FEATURES\b/i.test(text)) {
      inFeatures = true;
      continue;
    }

    if (inFeatures) {
      if (/^(OPTIONS|PREFERRED\s+SPECIFICATIONS)\b/i.test(text)) break;
      if (/^Description\b/i.test(text) || /\bLeather\b.*\bFabric\b/i.test(text)) break;
      if (text) featureLines.push(text);
    }
  }

  return featureLines.join("\n");
}

// ─── Standard features parsing ──────────────────────────────────

export interface ALStandardFeatures {
  standardSeat: string | null;
  standardBack: string | null;
  standardPillows: string | null;
  finish: string | null;
}

/**
 * Parse the STANDARD FEATURES text into structured fields.
 * AL standard features vary by program but typically include cushion type,
 * back construction, included pillows, and leg/base finish.
 */
export function parseStandardFeatures(text: string): ALStandardFeatures {
  const result: ALStandardFeatures = {
    standardSeat: null,
    standardBack: null,
    standardPillows: null,
    finish: null,
  };

  if (!text) return result;

  // Seat/cushion: "Seat cushion: Poly", "Cushion fill: Down", "cushion: Spring Down"
  const seatMatch = text.match(/(?:seat\s+)?cushion(?:\s+fill)?[:\s]+([^\n;]+)/i);
  if (seatMatch) result.standardSeat = seatMatch[1].trim();

  // Back: "Back: Tight", "Loose pillow back", "Back cushion: Fiber"
  const backMatch = text.match(/back(?:\s+cushion)?[:\s]+([^\n;]+)/i);
  if (backMatch) result.standardBack = backMatch[1].trim();

  // Pillows: "(2) toss pillows", "Includes (2) 18" throw pillows"
  // Simpler shape (capture pattern through "pillow(s)") avoids the
  // alternation-heavy regex S5843 flagged for complexity. The
  // `[^\n]{0,80}?` between the count and "pillow" is bounded so
  // backtracking is single-pass.
  // exec() preferred over .match() per Sonar S6594.
  const pillowMatch = /(?:includes?\s+)?(\(\d+\)[^\n]{0,80}?pillows?[^\n]*)/i.exec(text);
  if (pillowMatch) result.standardPillows = pillowMatch[1].trim();

  // Legs/base/finish: "Legs: Aluminum", "Base: Metal", "Standard finish: Wood"
  const legMatch = text.match(/(?:standard\s+)?(?:leg|base|finish)s?[:\s]+([^\n;]+)/i);
  if (legMatch) result.finish = legMatch[1].trim();

  return result;
}

/**
 * Parse product rows from the pricing table on a single page.
 *
 * Each product row contains a frame number matching FRAME_PATTERN,
 * followed by COM usage and 10 grade prices. The tab-separated
 * columns from columnAwarePageRenderer make this straightforward.
 */
function parseProductRows(
  lines: string[],
  collectionName: string,
  programType: string,
  pageNumber: number,
): ALParsedProduct[] {
  const products: ALParsedProduct[] = [];

  for (const line of lines) {
    const cells = line.split("\t").map((c) => c.trim());

    // Find the cell containing a valid frame number
    let frameIdx = -1;
    for (let j = 0; j < cells.length; j++) {
      if (FRAME_PATTERN.test(cells[j])) {
        frameIdx = j;
        break;
      }
    }

    if (frameIdx < 0) continue;

    const frameNumber = cells[frameIdx];

    // Description is everything before the frame number cell
    const description = cells.slice(0, frameIdx).join(" ").replace(/\s+/g, " ").trim();

    if (!description) continue;

    // COM usage is the cell immediately after the frame number
    const comUsageRaw = cells[frameIdx + 1] || "";
    const comUsage = Number.parseInt(comUsageRaw, 10) || null;

    // Grade prices: the next 10 cells after COM usage (if present)
    // or after frame number. The order matches ALL_GRADE_CODES:
    // C, D/F, G, H, J, I, II, III, V
    const priceStartIdx = frameIdx + 2; // skip frame + COM usage
    const gradePrices: { grade: string; cost: number }[] = [];

    // We expect exactly 10 price columns (5 leather + 4 fabric = 9... wait)
    // Actually: C | D/F C.O.L | G | H | J | I C.O.M. | II | III | V = 9 grades
    // But looking at the PDF, there are 10 price columns. Let me recount:
    // Leather: C, D/F, G, H, J = 5 cols
    // Fabric: I, II, III, V = 4 cols
    // Total: 9 price columns
    // The "C.O.L" and "C.O.M." are sub-labels, not separate columns.

    for (let k = 0; k < ALL_GRADE_CODES.length && priceStartIdx + k < cells.length; k++) {
      const rawPrice = cells[priceStartIdx + k];
      const price = parseCurrency(rawPrice);
      if (!isNaN(price) && price > 0) {
        gradePrices.push({ grade: ALL_GRADE_CODES[k], cost: price });
      }
    }

    // Only include rows that have at least a few valid grade prices
    if (gradePrices.length >= 3) {
      products.push({
        collectionName,
        programType,
        description,
        frameNumber,
        comUsage,
        gradePrices,
        pageNumber,
      });
    }
  }

  return products;
}

// ─── Option price extraction ──────────────────────────────────────

export interface ALOptionPrice {
  optionName: string;
  retailPrice: number | null;
  wholesalePrice: number | null;
  perSeat: boolean;
}

/**
 * Parse option prices from the OPTIONS text block of a page.
 * Returns structured option prices for cushion, mattress, power, battery, etc.
 */
export function parseOptionPrices(optionsText: string): ALOptionPrice[] {
  const options: ALOptionPrice[] = [];
  const seen = new Set<string>();

  const perSeat = /cushion\s+options\s+are\s+calculated\s+per\s+seat/i.test(optionsText);

  // Cushion options: *Dwn = $150, *Tufted = $100, *Trillium = $150
  // Capture "anything until =" (not = or newline) to avoid the
  // ambiguous \w/\s/\s* nesting that polynomial-redos flagged.
  // Greedy [^=\n]+ can't backtrack across `=` (excluded from char class),
  // so the match is single-pass linear. Closes Sonar S5852 hotspot.
  const cushionPattern = /\*([^=\n]+)=\s{0,16}\$(\d+)/g;
  let match;
  while ((match = cushionPattern.exec(optionsText)) !== null) {
    const name = match[1].trim();
    const price = Number.parseInt(match[2], 10);
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      options.push({ optionName: name, retailPrice: price, wholesalePrice: null, perSeat });
    }
  }

  // General priced options: "Name = $N" without asterisk prefix.
  // Catches nailhead, headrest, pillow upgrades, etc.
  // Excludes Power/Battery/Lumbar/Stitch (handled by extractPowerBatteryOptions)
  // and mattress rows (handled by parseMattressPrices).
  // [^=\n]+? avoids the ambiguous \w/\s/\s* nesting flagged by polynomial-redos.
  // Greedy [^=\n]* (anchored by \b\w then bounded by `=`) is single-pass linear.
  const generalPattern = /\b(\w[^=\n]*)=\s{0,16}\$\s{0,16}(\d[\d,]*)(?:\s{0,16}\/\s{0,16}seat)?/gi;
  while ((match = generalPattern.exec(optionsText)) !== null) {
    const name = match[1].trim();
    const lower = name.toLowerCase();
    // Skip if already captured or handled by other parsers
    if (seen.has(lower)) continue;
    if (/^(power|battery|lumbar|stitch)$/i.test(name)) continue;
    const price = Number.parseInt(match[2].replace(/,/g, ""), 10);
    if (!isNaN(price) && price > 0) {
      seen.add(lower);
      const isPerSeat = /\/\s{0,8}seat/i.test(match[0]);
      options.push({
        optionName: name,
        retailPrice: price,
        wholesalePrice: null,
        perSeat: isPerSeat,
      });
    }
  }

  return options;
}

/**
 * Parse mattress option prices from the OPTIONS text block.
 * Returns a map of size → { gel, tempurPedic } prices.
 */
export interface ALMattressPrice {
  size: string;
  gelPrice: number | null;
  tempurPedicPrice: number | null;
}

export function parseMattressPrices(optionsText: string): ALMattressPrice[] {
  const prices: ALMattressPrice[] = [];

  // Look for "MATTRESS OPTIONS" section and parse the size/price rows.
  // Bounded {1,16} prevents polynomial-redos on adversarial input
  // starting with 'mattress options' + many repetitions.
  // exec() preferred over .match() per Sonar S6594.
  const mattressSection = /MATTRESS\s{1,16}OPTIONS[\s\S]*?(?=\*|$)/i.exec(optionsText);
  if (!mattressSection) return prices;

  const block = mattressSection[0];

  // Pattern: SIZE  $GEL  $TEMPUR
  // e.g.: KING  $380  $1000
  // Anchor on a known base size word, capture any continuation (PLUS,
  // /QUEEN, COT, etc.) into a separate group, and let normalizeSize()
  // canonicalize. This avoids the complex alternation S5843 flagged.
  const sizePattern =
    /\b(KING|QUEEN|FULL|TWIN|COT|DOUBLE)([A-Z/\s]{0,16}?)\s{1,16}\$?(\d+)(?:\s{1,16}\$?(\d+))?/gi;
  let sizeMatch;
  while ((sizeMatch = sizePattern.exec(block)) !== null) {
    // sizeMatch[1] = base (KING/QUEEN/...), sizeMatch[2] = optional
    // continuation ("PLUS", "/QUEEN", " COT"). Concat both → normalizeSize().
    const size = `${sizeMatch[1]}${sizeMatch[2]}`.trim().toUpperCase();
    const price1 = Number.parseInt(sizeMatch[3], 10);
    const price2 = sizeMatch[4] ? Number.parseInt(sizeMatch[4], 10) : null;

    prices.push({
      size: normalizeSize(size),
      gelPrice: price1,
      tempurPedicPrice: price2,
    });
  }

  return prices;
}

// ─── Helpers ──────────────────────────────────────────────────────

function titleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeSize(size: string): string {
  const s = size.toUpperCase().replace(/\s+/g, " ");
  if (s.includes("KING")) return "KING";
  if (s.includes("QUEEN") && s.includes("PLUS")) return "QUEEN_PLUS";
  if (s.includes("QUEEN")) return "QUEEN";
  if (s.includes("FULL")) return "FULL";
  if (s.includes("TWIN") || s.includes("COT")) {
    if (s.includes("DOUBLE")) return "DOUBLE_COT";
    return "TWIN_COT";
  }
  return s;
}

// ─── Power / battery / lumbar option extraction ─────────────────

/**
 * Extract power, battery, lumbar, and similar surcharge options from the
 * OPTIONS text block. These use "Option = $N" or "Option=$N" format
 * (without the leading asterisk that cushion options use).
 */
export function extractPowerBatteryOptions(optionsText: string): ALOptionPrice[] {
  const options: ALOptionPrice[] = [];
  // Match patterns like "Power = $300", "Battery=$150", "Lumbar = $225/seat"
  // Bounded \s{...} prevents polynomial-redos on whitespace runs around
  // the optional `=` and `/`.
  const pattern =
    /\b(Power|Battery|Lumbar|Stitch)\s{0,8}=?\s{0,8}\$\s{0,8}([\d,]+)(?:\s{0,8}\/\s{0,8}seat)?/gi;
  let match;
  while ((match = pattern.exec(optionsText)) !== null) {
    const name = match[1].trim();
    const price = Number.parseInt(match[2].replace(/,/g, ""), 10);
    if (!isNaN(price) && price > 0) {
      const perSeat = /\/\s*seat/i.test(match[0]);
      options.push({ optionName: name, retailPrice: price, wholesalePrice: null, perSeat });
    }
  }
  return options;
}

// ─── Frame number size extraction ────────────────────────────────

const SIZE_SUFFIX_MAP: Record<string, string> = {
  KS: "KING",
  QP: "QUEEN_PLUS",
  QS: "QUEEN",
  FS: "FULL",
  TS: "TWIN_COT",
  CS: "TWIN_COT",
};

/**
 * Extract the mattress size from an AL frame number's trailing suffix.
 * Returns null for non-sleeper frames (ST, LA, RA, AA, etc.).
 */
export function frameSizeFromNumber(frameNumber: string): string | null {
  const parts = frameNumber.split("-");
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1].toUpperCase();
  return SIZE_SUFFIX_MAP[suffix] ?? null;
}

// ─── Exported grade constants ─────────────────────────────────────

export { LEATHER_GRADE_CODES, FABRIC_GRADE_CODES, ALL_GRADE_CODES };
