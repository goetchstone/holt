// /app/src/lib/pricing/jensenLeisureParser.ts
//
// PDF parser for Jensen Leisure retail price lists.
// Extracts cushioned seating (graded C/D/E/U by fabric), frame-only
// products, and cushion-only replacement items organized by collection.
// Prices in the PDF are retail; wholesale cost is derived during import.

import { extractPdfTextWithPages } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";

// ─── Exported types ──────────────────────────────────────────────

export interface ParsedJLProduct {
  itemNumber: string;
  description: string;
  collection: string;
  materialType: string | null;
  framePrice: number | null;
  gradePrices: { grade: string; retail: number }[];
  comYardage: number | null;
  isNew: boolean;
  isWSL: boolean;
  hasComfort: boolean;
  isCushionOnly: boolean;
  isFrameOnly: boolean;
  pageNumber: number;
}

export interface ParsedJLCollection {
  name: string;
  materialType: string;
}

export interface ParsedJLData {
  products: ParsedJLProduct[];
  collections: ParsedJLCollection[];
}

// ─── Helpers ─────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(?:^|\s|[-/])\w/g, (ch) => ch.toUpperCase());
}

const SKIP_PATTERNS = [
  /^ITEM\s*#/i,
  /^\*\*COM\s+yardages/i,
  /^Page\s+\d+/i,
  /^Rev\s+\d/i,
  /^New\s+for\s+20\d{2}/i,
  /^While\s+Supplies/i,
  /^Retailer\s+Wholesale/i,
  /^Select\s+Price/i,
  /^Effective\s/i,
  /^20\d{2}\s+Season/i,
  /^Contract$/i,
  /^Frame\b/i,
  /^C-grade/i,
  /^\*With\s+welt/i,
  /^\*First\s/i,
  /^Sling\s+Name/i,
  /^SERGE\s+FERRARI/i,
  /^(Light Gray|Nutmeg|Porcelain|Steel|Cobalt|Epidote|Jasper|Pyrite|Smokey)\s/i,
];

function shouldSkip(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return SKIP_PATTERNS.some((p) => p.test(trimmed));
}

// Known color/variant suffixes that should be kept in collection names
const VARIANT_SUFFIXES = /^(Natural|Gray|Ivory|Tawny Brown|Nebula Gray|Beige|Brown)$/i;
// Sub-group suffixes (distinct product groups within a collection)
const SUBGROUP_SUFFIXES = /\b(Tables|Accessories|Aluminum|Ipe|Teak)\b/i;

function parseCollectionHeader(line: string): { name: string; materialType: string | null } | null {
  const parts = line
    .split("\t")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const first = parts[0];
  if (/^\d/.test(first)) return null;
  if (first.includes("$")) return null;
  if (!/[A-Z]{2}/.test(first)) return null;

  // REPLACEMENT / OPTIONAL sub-sections: extract base collection name
  if (/\b(REPLACEMENT|OPTIONAL)\b/.test(first)) {
    const base = first.replace(/\s+(REPLACEMENT|OPTIONAL)[\s\w&]*$/i, "").trim();
    if (!base) return null;
    return { name: titleCase(base), materialType: null };
  }

  // Strip note suffixes (lowercase phrases after " - ") while keeping
  // color variants and sub-group identifiers
  let name = first;
  const dashIdx = name.indexOf(" - ");
  if (dashIdx > 0) {
    const suffix = name.substring(dashIdx + 3).trim();
    if (!VARIANT_SUFFIXES.test(suffix) && !SUBGROUP_SUFFIXES.test(suffix)) {
      name = name.substring(0, dashIdx).trim();
    }
  }

  let materialType: string | null = null;
  if (parts.length > 1) {
    const candidate = parts[1];
    if (/\b(Wood|Fiber|Aluminum|Sling|Cushion|Teak|Ipe|Woven)\b/i.test(candidate)) {
      materialType = candidate.replace(/\s*\*.*$/, "").trim();
    }
  }

  return { name: titleCase(name), materialType };
}

const GRADES = ["C", "D", "E", "U"];

function parseProductRow(
  line: string,
  currentPage: number,
  currentCollection: string,
  currentMaterial: string | null,
): ParsedJLProduct | null {
  // Merge standalone $ with the next tab-separated token. In PDF tables
  // the dollar sign and number often render as separate text items.
  const processed = line.replace(/\$\s*(\t\s*)+/g, "$");
  const parts = processed
    .split("\t")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  const itemNumber = parts[0];
  if (!/^\d{4,6}[CP]?$/i.test(itemNumber)) return null;

  // Build description from parts until we hit a flag or price token
  const descParts: string[] = [];
  let idx = 1;
  for (; idx < parts.length; idx++) {
    const part = parts[idx];
    if (/New\s*'?\d{2}/i.test(part) || /WSL/i.test(part) || /\u2756/.test(part)) break;
    if (/^\$/.test(part)) break;
    descParts.push(part);
  }
  const description = descParts
    .join(" ")
    .replace(/\s*\*\s*$/, "")
    .trim();
  if (!description) return null;

  // Extract flags
  let isNew = false;
  let isWSL = false;
  for (; idx < parts.length; idx++) {
    const part = parts[idx];
    if (/New\s*'?\d{2}/i.test(part)) {
      isNew = true;
      continue;
    }
    if (/WSL/i.test(part) || /\u2756/.test(part)) {
      isWSL = true;
      continue;
    }
    break;
  }

  // Remaining parts: prices (Frame, C, D, E, U), then comfort (Y/N), then COM Yds
  const rawPrices: (number | null)[] = [];
  let hasComfort = false;
  let comYardage: number | null = null;

  for (; idx < parts.length; idx++) {
    const part = parts[idx];
    if (part === "Y" || part === "N") {
      hasComfort = part === "Y";
      continue;
    }

    if (/^\$/.test(part)) {
      const val = parseCurrency(part);
      rawPrices.push(isNaN(val) ? null : val);
    } else {
      const num = Number.parseFloat(part.replace(/,/g, ""));
      if (!isNaN(num)) {
        if (rawPrices.length >= 5 && num < 20) {
          comYardage = num;
        } else {
          rawPrices.push(num);
        }
      }
    }
  }

  // Map prices: [Frame, C, D, E, U]
  const framePrice = rawPrices.length > 0 ? rawPrices[0] : null;
  const gradePrices: { grade: string; retail: number }[] = [];
  for (let g = 0; g < GRADES.length; g++) {
    const price = rawPrices.length > g + 1 ? rawPrices[g + 1] : null;
    if (price != null) {
      gradePrices.push({ grade: GRADES[g], retail: price });
    }
  }

  const isCushionOnly = /C$/i.test(itemNumber) && itemNumber.length > 1;
  const isFrameOnly = framePrice != null && gradePrices.length === 0;

  return {
    itemNumber,
    description,
    collection: currentCollection,
    materialType: currentMaterial,
    framePrice,
    gradePrices,
    comYardage,
    isNew,
    isWSL,
    hasComfort,
    isCushionOnly,
    isFrameOnly,
    pageNumber: currentPage,
  };
}

// ─── Main parser ─────────────────────────────────────────────────

export async function parseJensenLeisureWholesale(buffer: Buffer): Promise<ParsedJLData> {
  const raw = await extractPdfTextWithPages(buffer);
  const lines = raw.split("\n");

  const products: ParsedJLProduct[] = [];
  const collectionMap = new Map<string, string>();

  let currentCollection = "Uncategorized";
  let currentMaterial: string | null = null;
  let currentPage = 1;
  let inTensionSlings = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const pageMatch = line.match(/<<PAGE:(\d+)>>/);
    if (pageMatch) {
      currentPage = Number.parseInt(pageMatch[1]);
      inTensionSlings = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (shouldSkip(trimmed)) continue;

    // Tension Slings table at end of PDF uses a non-standard layout
    if (/TENSION SLINGS/i.test(trimmed)) {
      inTensionSlings = true;
      continue;
    }
    if (inTensionSlings) continue;

    // Try collection header
    const collection = parseCollectionHeader(trimmed);
    if (collection) {
      currentCollection = collection.name;
      if (collection.materialType) {
        currentMaterial = collection.materialType;
      }
      if (!collectionMap.has(currentCollection)) {
        collectionMap.set(currentCollection, currentMaterial || "");
      }
      continue;
    }

    // Try product row
    const product = parseProductRow(trimmed, currentPage, currentCollection, currentMaterial);
    if (product) {
      products.push(product);
    }
  }

  const collections: ParsedJLCollection[] = [];
  collectionMap.forEach((materialType, name) => {
    collections.push({ name, materialType });
  });

  return { products, collections };
}
