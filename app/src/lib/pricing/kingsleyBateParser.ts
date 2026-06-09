// /app/src/lib/pricing/kingsleyBateParser.ts
//
// Server-side PDF parser for Kingsley Bate retail price lists.
//
// Kingsley Bate is an outdoor furniture vendor using the FRAME_PLUS_CUSHION
// pricing model: frames and cushions are priced separately, with cushion
// prices varying by fabric grade (QS, A, B, C, D).
//
// The PDF has these sections:
//   pp.2:     How to Order (model number guide, finish key reference)
//   pp.3-21:  Furniture frames (organized by collection, then category)
//   pp.21:    Accessories (cushion boxes, umbrellas, bases, etc.)
//   pp.22:    Care & Maintenance (teak care products)
//   pp.23-28: Furniture covers (organized by collection)
//   pp.29-34: Cushion ordering guide, quick ship, fabrics, restrictions
//   pp.35-43: Cushion pricing - current frames (by category, then code)
//   pp.44:    Pillows, umbrella canopies, fabric (cut yardage)
//   pp.45-49: Cushion pricing - discontinued frames (by collection)
//   pp.50:    C.O.M. ordering guide

import { extractPdfTextWithPages } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";

// ─── Exported types ──────────────────────────────────────────────

export interface ParsedKBFrame {
  styleNumber: string;
  description: string;
  collection: string;
  category: string;
  cushionRef: string | null;
  framePrice: number;
  combinedPrices: {
    a: number | null;
    b: number | null;
    c: number | null;
    d: number | null;
  };
  width: number | null;
  depth: number | null;
  height: number | null;
  packQuantity: number;
  stockedFinishes: string;
  specialOrderOptions: string;
  notes: string[];
}

export interface ParsedKBCushion {
  cushionCode: string;
  fitsFrames: string[];
  description: string;
  styleKeys: string[];
  fabricRestriction: string | null;
  prices: {
    qs: number | null;
    a: number | null;
    b: number | null;
    c: number | null;
    d: number | null;
  };
  comYardage: number | null;
  isDiscontinued: boolean;
}

export interface ParsedKBCover {
  coverCode: string;
  fitsFrame: string;
  description: string;
  retailPrice: number;
}

export interface ParsedKBFabric {
  name: string;
  code: string;
  weltType: string;
  grade: string;
  restrictionCode: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Remove footnote markers (*, dagger, superscripts) from item codes. */
function cleanItemCode(raw: string): string {
  return raw.replace(/[*†§¶‡Δ▲]/g, "").trim();
}

/** Category headers start with a triangle marker or specific keywords. */
const CATEGORY_PREFIXES = [
  "DINING",
  "DEEP SEATING",
  "CLUB SEATING",
  "CHAISE LOUNGE",
  "SECTIONAL",
  "OCCASIONAL TABLES",
  "COUNTER & BAR",
  "CAFÉ TABLES",
  "BENCH",
  "DINING TABLES",
  "DINING & BAR",
  "BAR",
  "COUNTER",
  "CHAISE LOUNGE & ROCKER",
  "OCCASIONAL TABLES & STORAGE",
];

function isCategoryLine(line: string): string | null {
  const trimmed = line.replace(/^[▼▾►▸●○◆♦\s]+/, "").trim();
  for (const prefix of CATEGORY_PREFIXES) {
    if (trimmed.toUpperCase().startsWith(prefix)) {
      return trimmed;
    }
  }
  return null;
}

/** Collection headers: all-caps text, not a known section keyword. */
const SECTION_KEYWORDS = new Set([
  "FURNITURE",
  "ITEM",
  "ACCESSORIES",
  "CARE & MAINTENANCE",
  "TEAK CARE PRODUCTS",
  "FURNITURE COVERS",
  "CUSHION PRICING",
  "CUSHION SECTION CONTENTS",
  "HOW THE PRICING PAGES WORK",
  "QUICK SHIP CUSHIONS & UMBRELLA CANOPIES",
  "CUSTOM ORDER CUSHIONS",
  "UPHOLSTERY CUSTOMIZATION PRICES",
  "STOCKED FABRICS",
  "FABRIC RESTRICTIONS",
  "PILLOWS",
  "SUGGESTED RETAIL PRICES",
  "FINISH KEY",
  "STANDARD PERFORMANCE",
  "HIGH PERFORMANCE",
  "CONTENTS",
  "BRASS PLAQUES",
  "CUSHION BOXES",
  "LAZY SUSAN",
  "MARKET UMBRELLAS",
  "UMBRELLA BASES",
  "UMBRELLA HOLE REDUCER RINGS",
  "SERVING CART",
  // FINISH KEY material names (appear standalone on page footers)
  "ALUMINUM",
  "ROPE",
  "SLING",
  "STEEL",
  "TEAK",
  "TEMPEPLEX",
  "WICKER",
]);

function isCollectionHeader(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return false;
  if (SECTION_KEYWORDS.has(trimmed.toUpperCase())) return false;
  const base = trimmed.split(/\s*[-–]\s*/)[0].trim();
  if (base.length < 3) return false;
  return /^[A-ZÉ][A-ZÉ\s.&']+$/.test(base) && !base.startsWith("SEE ");
}

/** Parse a dimension value, handling "Dia." notation. */
function parseDimension(val: string): { value: number | null; isDiameter: boolean } {
  if (!val || val === "-") return { value: null, isDiameter: false };
  const cleaned = val.replace(/["\s]/g, "");
  if (cleaned.toLowerCase().includes("dia")) {
    const num = Number.parseFloat(cleaned.replace(/dia\.?/i, ""));
    return { value: isNaN(num) ? null : num, isDiameter: true };
  }
  const num = Number.parseFloat(cleaned);
  return { value: isNaN(num) ? null : num, isDiameter: false };
}

/**
 * Extract the first tab-separated field from a line.
 * Used for section detection where the marker text may have other
 * content after a tab (e.g., "FURNITURE\t1").
 */
function firstTabField(line: string): string {
  const idx = line.indexOf("\t");
  return (idx >= 0 ? line.slice(0, idx) : line).trim();
}

// ─── Frame Parser (pp.3-21) ──────────────────────────────────────

export async function parseKingsleyBateFrames(pdfBuffer: Buffer): Promise<ParsedKBFrame[]> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);
  return parseFrameLines(rawText.split("\n"));
}

function parseFrameLines(lines: string[]): ParsedKBFrame[] {
  const frames: ParsedKBFrame[] = [];
  let currentCollection = "";
  let currentCategory = "";
  let stockedFinishes = "";
  let specialOrderOptions = "";
  let pendingFrames: ParsedKBFrame[] = [];
  let inFrameSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^<<PAGE:\d+>>$/.test(trimmed)) continue;

    const field0 = firstTabField(line);

    // Detect start of frame section: "FURNITURE" appears as first tab field
    if (field0 === "FURNITURE" && !inFrameSection) {
      inFrameSection = true;
      continue;
    }
    // End markers: ACCESSORIES or CARE & MAINTENANCE as first tab field
    if (inFrameSection && (field0 === "ACCESSORIES" || field0.startsWith("CARE & MAINTENANCE"))) {
      flushPendingFrames(pendingFrames, stockedFinishes, specialOrderOptions, frames);
      pendingFrames = [];
      inFrameSection = false;
      continue;
    }
    if (!inFrameSection) continue;

    // Skip header rows and page footers
    if (/^Item\s+Description/i.test(trimmed)) continue;
    if (/^See page \d/i.test(trimmed)) continue;
    if (/^FINISH KEY/i.test(field0)) continue;
    if (/^(ALUMINUM|ROPE|SLING|STEEL|TEAK|TEMPEPLEX|WICKER)(\s|$)/i.test(field0)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (trimmed.startsWith("Frame + Cushion")) continue;
    if (trimmed.startsWith("Exterior")) continue;
    if (trimmed.startsWith("Dimensions")) continue;
    if (/^Cushion\s+Frame\s+A\s+B\s+C\s+D/i.test(trimmed)) continue;
    if (/^SUGGESTED RETAIL PRICES/i.test(field0)) continue;
    if (/^◆\s*FOOTNOTES/i.test(trimmed)) continue;
    if (/^\d+Price includes/i.test(trimmed)) continue;
    if (/^\d+Order \(\d+\)/i.test(trimmed)) continue;
    if (/^\d+For products with/i.test(trimmed)) continue;
    if (/^\*Item must/i.test(trimmed)) continue;
    if (/^[∆†‡§]+/i.test(trimmed)) continue;

    // STOCKED line
    if (/^[●○]\s*STOCKED/i.test(trimmed) || /^STOCKED/i.test(trimmed)) {
      const match = trimmed.match(/STOCKED\s*\(([^)]+)\)\s*:?\s*(.*)/i);
      if (match) {
        const material = match[1].trim();
        const codes = match[2].trim();
        stockedFinishes += (stockedFinishes ? " | " : "") + `${material}: ${codes}`;
      }
      continue;
    }

    // SPECIAL ORDER line
    if (/^[●○]\s*SPECIAL ORDER/i.test(trimmed) || /^SPECIAL ORDER/i.test(trimmed)) {
      const match = trimmed.match(/SPECIAL ORDER\s*\(([^)]+)\)\s*:?\s*(.*)/i);
      if (match) {
        const material = match[1].trim();
        const codes = match[2].trim();
        specialOrderOptions += (specialOrderOptions ? " | " : "") + `${material}: ${codes}`;
      }
      continue;
    }

    // STOCKED COMBINATIONS
    if (/^STOCKED COMBINATIONS/i.test(trimmed)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const sub = lines[j].trim();
        if (!sub || isCollectionHeader(sub) || isCategoryLine(sub)) break;
        if (sub.startsWith("-") || sub.startsWith("Teak") || sub.startsWith("Wicker")) {
          stockedFinishes += (stockedFinishes ? " | " : "") + sub.replace(/^-\s*/, "");
        }
      }
      continue;
    }

    // Notes/footnotes
    if (/^[◆♦]\s*NOTE/i.test(trimmed) || /^NOTE:/i.test(trimmed)) continue;
    if (/^[◆♦]\s/i.test(trimmed)) continue;
    if (/^[-–]\s*(Seating|Tables|Dining|Wicker|Sling)/i.test(trimmed)) {
      stockedFinishes += (stockedFinishes ? " | " : "") + trimmed.replace(/^[-–]\s*/, "");
      continue;
    }

    // "(continued from page N)" header — check before collection header
    if (/\(continued/i.test(trimmed) && !trimmed.includes("\t")) {
      const contMatch = trimmed.match(/^(.+?)\s*\(continued/i);
      if (contMatch) currentCollection = contMatch[1].trim();
      continue;
    }

    // Collection header detection (must not have tabs -- tab data is a data row)
    if (isCollectionHeader(trimmed) && !trimmed.includes("\t")) {
      flushPendingFrames(pendingFrames, stockedFinishes, specialOrderOptions, frames);
      pendingFrames = [];
      stockedFinishes = "";
      specialOrderOptions = "";
      currentCollection = trimmed.replace(/\s*\(continued.*$/i, "").trim();
      currentCategory = "";
      continue;
    }

    // Category header detection
    const cat = isCategoryLine(trimmed);
    if (cat && !trimmed.includes("\t")) {
      currentCategory = cat;
      continue;
    }

    // Data rows must have tabs
    if (!line.includes("\t")) continue;

    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 3) continue;

    // Parse as frame data row
    const itemCode = cleanItemCode(parts[0]);
    if (!itemCode || !/^[A-Z]{2}/.test(itemCode)) continue;

    const description = parts[1] || "";
    const cushionRef = parts[2] && parts[2] !== "-" ? cleanItemCode(parts[2]) : null;
    const framePrice = parseCurrency(parts[3] || "");
    if (isNaN(framePrice)) continue;

    const priceA = parts[4] ? parseCurrency(parts[4]) : NaN;
    const priceB = parts[5] ? parseCurrency(parts[5]) : NaN;
    const priceC = parts[6] ? parseCurrency(parts[6]) : NaN;
    const priceD = parts[7] ? parseCurrency(parts[7]) : NaN;

    const dimW = parts[8] ? parseDimension(parts[8]) : { value: null, isDiameter: false };
    const dimD = parts[9] ? parseDimension(parts[9]) : { value: null, isDiameter: false };
    const dimH = parts[10] ? parseDimension(parts[10]) : { value: null, isDiameter: false };
    const pack = parts[11] ? Number.parseInt(parts[11], 10) : 1;

    const width = dimW.value;
    const depth = dimW.isDiameter ? dimW.value : dimD.value;
    const height = dimH.value;

    const frame: ParsedKBFrame = {
      styleNumber: itemCode,
      description,
      collection: currentCollection,
      category: currentCategory,
      cushionRef,
      framePrice,
      combinedPrices: {
        a: isNaN(priceA) ? null : priceA,
        b: isNaN(priceB) ? null : priceB,
        c: isNaN(priceC) ? null : priceC,
        d: isNaN(priceD) ? null : priceD,
      },
      width,
      depth,
      height,
      packQuantity: isNaN(pack) ? 1 : pack,
      stockedFinishes: "",
      specialOrderOptions: "",
      notes: [],
    };

    pendingFrames.push(frame);
  }

  flushPendingFrames(pendingFrames, stockedFinishes, specialOrderOptions, frames);
  return frames;
}

function flushPendingFrames(
  pending: ParsedKBFrame[],
  stocked: string,
  specialOrder: string,
  output: ParsedKBFrame[],
): void {
  for (const f of pending) {
    f.stockedFinishes = stocked;
    f.specialOrderOptions = specialOrder;
    output.push(f);
  }
}

// ─── Cushion Parser (pp.35-49) ───────────────────────────────────

export async function parseKingsleyBateCushions(pdfBuffer: Buffer): Promise<ParsedKBCushion[]> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);
  return parseCushionLines(rawText.split("\n"));
}

/**
 * Extract grade prices (QS, A, B, C, D) and COM yardage from the end of
 * a concatenated line. Prices are space-separated at the line's tail,
 * optionally prefixed with `$` and containing commas for thousands.
 *
 * Returns null if valid prices cannot be found.
 */
function extractCushionPrices(tokens: string[]): {
  qs: number | null;
  a: number | null;
  b: number | null;
  c: number | null;
  d: number | null;
  com: number | null;
} | null {
  if (tokens.length < 5) return null;

  // COM yardage is the last token (decimal/integer < 20, or "NA")
  const lastToken = tokens[tokens.length - 1];
  let com: number | null = null;
  if (lastToken === "NA") {
    com = null;
  } else {
    const comVal = Number.parseFloat(lastToken);
    if (isNaN(comVal) || comVal < 0 || comVal > 20) return null;
    com = comVal;
  }

  // Read up to 5 price tokens right-to-left before COM
  const prices: (number | null)[] = [];
  for (let i = tokens.length - 2; i >= 0 && prices.length < 5; i--) {
    const raw = tokens[i].replace(/^\$/, "");
    if (raw === "-") {
      prices.unshift(null);
    } else {
      const val = Number.parseFloat(raw.replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        prices.unshift(val);
      } else {
        break;
      }
    }
  }

  if (prices.length < 4) return null;

  // Pad to 5 values (QS may be absent)
  while (prices.length < 5) {
    prices.unshift(null);
  }

  return { qs: prices[0], a: prices[1], b: prices[2], c: prices[3], d: prices[4], com };
}

/**
 * Extract frame codes (2-3 letters + 2+ digits) from a string,
 * excluding a known CUS code.
 */
function extractFrameCodes(text: string, cusCode: string): string[] {
  const afterCus = text.replace(cusCode, "");
  const codes: string[] = [];
  const regex = /\b([A-Z]{2,3}\d{2,}\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(afterCus)) !== null) {
    codes.push(m[1]);
  }
  return codes;
}

function parseCushionLines(lines: string[]): ParsedKBCushion[] {
  const cushions: ParsedKBCushion[] = [];
  let inCushionSection = false;
  let isDiscontinued = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<<PAGE:\d+>>$/.test(trimmed)) continue;

    // Section detection
    if (/CUSHION PRICING\s*\|\s*CURRENT FRAMES/i.test(trimmed)) {
      inCushionSection = true;
      isDiscontinued = false;
      continue;
    }
    if (/CUSHION PRICING\s*\|\s*DISCONTINUED FRAMES/i.test(trimmed)) {
      inCushionSection = true;
      isDiscontinued = true;
      continue;
    }
    // End of all cushion sections: C.O.M. ordering guide
    if (inCushionSection && /^C\.?O\.?M\.?\s+ORDERING/i.test(trimmed)) {
      inCushionSection = false;
      continue;
    }

    if (!inCushionSection) continue;

    // Skip non-data lines
    if (/^(STYLE KEY|See page|HOW THE PRICING|Fabric Restriction|CUSHION PRICING)/i.test(trimmed))
      continue;
    if (/^Cushion\t/i.test(line)) continue;
    if (/^◆\s*NOTE/i.test(trimmed)) continue;
    if (/^[▼▾]\s/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^\d+\tSee page/i.test(line)) continue;
    if (/^\*\s+Fabric/i.test(trimmed)) continue;
    if (/^†\s+Fabric/i.test(trimmed)) continue;
    if (/^‡\s+Fabric/i.test(trimmed)) continue;

    // Must contain a CUS code and have at least one tab
    if (!/\bCUS\w+/.test(line)) continue;
    if (!line.includes("\t")) continue;

    // Extract the CUS code
    const cusMatch = line.match(/\b(CUS(?:CR|\w+))\b/);
    if (!cusMatch) continue;
    const cushionCode = cusMatch[1];

    // Merge all tab fields into a single space-separated string for price extraction
    const fullText = line.replace(/\t/g, "  ").replace(/\s+/g, " ").trim();
    const tokens = fullText.split(" ");

    const priceData = extractCushionPrices(tokens);
    if (!priceData) continue;

    // Extract fits frames from the first tab field
    const parts = line.split("\t").map((s) => s.trim());
    const fitsFrames = extractFrameCodes(parts[0], cushionCode);

    // If fits frames not found in field 0, check field 1
    if (fitsFrames.length === 0 && parts.length > 1) {
      const moreFrames = extractFrameCodes(parts[1], cushionCode);
      fitsFrames.push(...moreFrames);
    }

    // Extract fabric restriction: look for R-codes in tab fields
    let fabricRestriction: string | null = null;
    for (const part of parts) {
      const rMatch = part.match(/^(R[1-7](?:,\s*R[1-7])*)$/);
      if (rMatch) {
        fabricRestriction = rMatch[1].replace(/\s/g, "");
        break;
      }
      // Also match R-codes with footnote markers like "R5*" or "R2"
      const rMatchFn = part.match(/^(R[1-7](?:,\s*R[1-7])*)[*†‡§]?$/);
      if (rMatchFn) {
        fabricRestriction = rMatchFn[1].replace(/\s/g, "");
        break;
      }
    }

    // Extract description from middle tab fields.
    // Look for the field that contains descriptive text (not prices, not codes).
    let description = "";
    for (let p = 1; p < parts.length; p++) {
      const field = parts[p];
      // Skip fields that are clearly not descriptions
      if (!field || field === "-") continue;
      if (/^R[1-7]/.test(field)) continue;
      if (/^\d/.test(field) && field.length <= 3) continue;
      if (/^\$/.test(field)) continue;
      // Skip fields that are style keys only (e.g., "BE, W, T")
      if (/^[A-Z]{1,2}(?:,\s*[A-Z]{1,2})*$/.test(field)) continue;
      // Skip fields that look like pure price data
      if (/^[-$\d,.\s]+$/.test(field)) continue;
      // Skip seat/back style lines
      if (/^(Seat|Back):/i.test(field)) continue;
      // This looks like a description
      if (field.length > 5) {
        description = field;
        break;
      }
    }

    // Extract style keys from the line
    const styleKeys: string[] = [];
    const styleRegex = /\b(BE|BN|KE|WF|W|T)\b/g;
    let sm: RegExpExecArray | null;
    // Search style keys only in the middle portion (not in CUS code or prices)
    const middleText = parts.slice(1, -1).join(" ");
    while ((sm = styleRegex.exec(middleText)) !== null) {
      if (!styleKeys.includes(sm[1])) {
        styleKeys.push(sm[1]);
      }
    }

    cushions.push({
      cushionCode,
      fitsFrames,
      description,
      styleKeys,
      fabricRestriction,
      prices: {
        qs: priceData.qs,
        a: priceData.a,
        b: priceData.b,
        c: priceData.c,
        d: priceData.d,
      },
      comYardage: priceData.com,
      isDiscontinued,
    });
  }

  // Deduplicate: current cushions take priority over discontinued.
  // The same code can appear in both sections with different prices.
  const deduped = new Map<string, ParsedKBCushion>();
  for (const cushion of cushions) {
    const existing = deduped.get(cushion.cushionCode);
    if (!existing || existing.isDiscontinued) {
      deduped.set(cushion.cushionCode, cushion);
    }
  }
  return Array.from(deduped.values());
}

// ─── Cover Parser (pp.23-28) ─────────────────────────────────────

export async function parseKingsleyBateCovers(pdfBuffer: Buffer): Promise<ParsedKBCover[]> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);
  return parseCoverLines(rawText.split("\n"));
}

function parseCoverLines(lines: string[]): ParsedKBCover[] {
  const covers: ParsedKBCover[] = [];
  let inCoverSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const field0 = firstTabField(line);

    // Detect cover section
    if (field0 === "FURNITURE COVERS") {
      inCoverSection = true;
      continue;
    }
    if (inCoverSection && field0 === "CUSHION SECTION CONTENTS") {
      inCoverSection = false;
      continue;
    }
    if (!inCoverSection) continue;

    // Skip non-data lines
    if (/^<<PAGE:\d+>>$/.test(trimmed)) continue;
    if (/^Cover\s+Fits Frame/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^[▼▾►]/i.test(trimmed)) continue;
    if (/^HOW TO ORDER/i.test(trimmed)) continue;
    if (/^[◆♦]\s/i.test(trimmed)) continue;
    if (/^EXTEND THE LIFE/i.test(trimmed)) continue;
    if (/^Order \d/i.test(trimmed)) continue;
    if (/^Main panels/i.test(trimmed)) continue;
    if (/^Example:/i.test(trimmed)) continue;
    if (/^Our sectional/i.test(trimmed)) continue;
    if (/^Covers for/i.test(trimmed)) continue;
    if (/^Protect dining/i.test(trimmed)) continue;
    if (/^Individual chair/i.test(trimmed)) continue;
    if (/^NOTE:/i.test(trimmed)) continue;

    if (!line.includes("\t")) continue;

    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 3) continue;

    const coverCode = parts[0].trim();
    if (!coverCode.startsWith("FC") && !coverCode.startsWith("CVR")) continue;

    const fitsFrame = parts[1] || "-";
    const description = parts[2] || "";
    const priceStr = parts[3] || parts[parts.length - 1] || "";
    const retailPrice = parseCurrency(priceStr);
    if (isNaN(retailPrice)) continue;

    covers.push({
      coverCode,
      fitsFrame: fitsFrame === "-" ? "" : fitsFrame,
      description,
      retailPrice,
    });
  }

  return covers;
}

// ─── Fabric Parser (p.33) ────────────────────────────────────────

export async function parseKingsleyBateFabrics(pdfBuffer: Buffer): Promise<ParsedKBFabric[]> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);
  return parseFabricLines(rawText.split("\n"));
}

/**
 * Parse a single fabric entry from 5 tab-separated fields:
 * [name, code, weltType, grade, restrictionCode]
 */
function parseFabricEntry(fields: string[]): ParsedKBFabric | null {
  const name = fields[0];
  if (!name || /^\d+$/.test(name)) return null;
  // Skip sub-headers that sneak into fabric columns
  if (/^(HIGH PERFORMANCE|SUNBRELLA|Description|STANDARD)/i.test(name)) return null;

  const code = fields[1] || "";
  if (!code) return null;

  const weltType = fields[2] || "Self";
  const grade = fields[3] || "";
  if (!/^[A-D]$/.test(grade)) return null;

  const restrictionCode = fields[4] && fields[4] !== "-" ? fields[4] : null;

  return {
    name: name.trim(),
    code: code.trim(),
    weltType: weltType.trim(),
    grade,
    restrictionCode,
  };
}

function parseFabricLines(lines: string[]): ParsedKBFabric[] {
  const fabrics: ParsedKBFabric[] = [];
  let inFabricSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<<PAGE:\d+>>$/.test(trimmed)) continue;

    const field0 = firstTabField(line);

    // Detect fabric section: "STOCKED FABRICS" may have trailing tab content
    if (/^STOCKED FABRICS$/i.test(field0)) {
      inFabricSection = true;
      continue;
    }
    // End at FABRIC RESTRICTIONS section
    if (inFabricSection && /^FABRIC RESTRICTIONS$/i.test(field0)) {
      inFabricSection = false;
      continue;
    }
    if (!inFabricSection) continue;

    // Skip headers and notes
    if (/^Description\t/i.test(line)) continue;
    if (/^(Select from|All stocked|Need Fabric|emailteak)/i.test(trimmed)) continue;
    if (/^[◆♦]\s*NOTE/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^STANDARD PERFORMANCE/i.test(field0)) continue;
    if (/^HIGH PERFORMANCE/i.test(field0)) continue;
    if (/^Fabric Restriction/i.test(trimmed)) continue;

    if (!line.includes("\t")) continue;

    const parts = line.split("\t").map((s) => s.trim());

    // The fabric page uses a two-column side-by-side layout.
    // Rows with 8-10 tab fields contain two fabric entries:
    //   fields 0-4: left column (name, code, welt, grade, restriction)
    //   fields 5-9: right column (name, code, welt, grade, restriction)
    // Rows with 4-5 fields contain a single fabric entry.

    if (parts.length >= 8) {
      // Two-column row
      const left = parseFabricEntry(parts.slice(0, 5));
      if (left) fabrics.push(left);

      const right = parseFabricEntry(parts.slice(5, 10));
      if (right) fabrics.push(right);
    } else if (parts.length >= 4) {
      // Single-column row (occurs near bottom where right column is empty or has
      // a section header like "HIGH PERFORMANCE")
      const entry = parseFabricEntry(parts.slice(0, 5));
      if (entry) fabrics.push(entry);
    }
  }

  return fabrics;
}

// ─── Convenience: parse everything at once ───────────────────────

export interface ParsedKingsleyBateData {
  frames: ParsedKBFrame[];
  cushions: ParsedKBCushion[];
  covers: ParsedKBCover[];
  fabrics: ParsedKBFabric[];
}

/**
 * Parse all sections of the Kingsley Bate price list PDF.
 * Extracts text once and dispatches to section-specific parsers.
 */
export async function parseKingsleyBatePriceList(
  pdfBuffer: Buffer,
): Promise<ParsedKingsleyBateData> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);
  const lines = rawText.split("\n");

  return {
    frames: parseFrameLines(lines),
    cushions: parseCushionLines(lines),
    covers: parseCoverLines(lines),
    fabrics: parseFabricLines(lines),
  };
}
