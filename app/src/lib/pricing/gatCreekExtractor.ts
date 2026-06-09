// /app/src/lib/pricing/gatCreekExtractor.ts
//
// PDF parser for Gat Creek / Caperton wholesale price lists.
//
// The price list has two main sections:
//   1. Wholesale table (pages 2-15) — line-item products with up to 5 species columns:
//      ASH | CHERRY | MAPLE | WALNUT | PAINT
//      Some products have fewer columns (chairs may omit MAPLE and/or PAINT).
//
//   2. Custom Shop (pages 18-41) — dining tables priced on 2D grids:
//      Width × Length × Species for rectangular tables
//      Diameter × Species for round tables
//      Each table style has Fixed Top + Extension Top (+ sometimes Round) variants.
//      Each grid also has a parallel SKU matrix.

import { extractPdfTextWithPages } from "./pdfUtils";
import { parseCurrency } from "./pricingUtils";

// ─── Exported types ──────────────────────────────────────────────

export interface ParsedGatCreekProduct {
  itemNumber: string;
  description: string;
  size: string | null; // "Single", "Queen", "42\"", "48x48", etc.
  pricingType: "SPECIES" | "MATRIX" | "ROUND";
  pageNumber: number | null;

  // SPECIES: up to 5 prices
  speciesPrices: {
    ash: number | null;
    cherry: number | null;
    maple: number | null;
    walnut: number | null;
    paint: number | null;
  } | null;

  // MATRIX: rectangular width × length × species
  matrixPrices: MatrixEntry[] | null;

  // ROUND: diameter × species
  roundPrices: RoundEntry[] | null;

  // Table style & variant info (Custom Shop only)
  tableStyle: string | null; // "Austin", "Claire", etc.
  tableVariant: string | null; // "Fixed Top", "Extension Top", "Round Fixed Top", etc.
  contrastingBaseSurcharge: number | null;
  leafInfo: string | null; // "STANDARD WITH ONE 18\" LEAF. ADDITIONAL 18\" LEAF: $100"
}

export interface MatrixEntry {
  species: string; // "Ash/Cherry/Maple", "Paint", "Walnut"
  width: number; // inches
  length: number; // inches
  cost: number;
  sku: string | null;
}

export interface RoundEntry {
  species: string;
  diameter: number;
  cost: number;
  sku: string | null;
}

// ─── Internal line type with page tracking ───────────────────────

interface PLine {
  text: string;
  page: number;
}

// ─── Main entry point ────────────────────────────────────────────

export async function extractGatCreekPricing(pdfBuffer: Buffer): Promise<ParsedGatCreekProduct[]> {
  const rawText = await extractPdfTextWithPages(pdfBuffer);

  // Split by page markers: <<PAGE:N>>
  const segments = rawText.split(/<<PAGE:(\d+)>>\n/);
  const lines: PLine[] = [];

  // segments: ["", "1", "page1text", "2", "page2text", ...]
  for (let s = 1; s < segments.length; s += 2) {
    const page = Number.parseInt(segments[s], 10);
    const pageText = segments[s + 1] || "";
    for (const line of pageText.split("\n")) {
      lines.push({ text: line, page });
    }
  }

  const products: ParsedGatCreekProduct[] = [];
  const wholesaleProducts = parseWholesaleTable(lines);
  const customShopProducts = parseCustomShop(lines);

  products.push(...wholesaleProducts);
  products.push(...customShopProducts);

  return products;
}

// ─── Wholesale table parser (pages 2-15) ─────────────────────────

const HEADER_RE =
  /^PRODUCT NAME\t(?:SIZE\t)?SKU\t(?:ASH\t)?(?:CHERRY\t)?(?:MAPLE\t)?(?:WALNUT\t)?(?:PAINT)?/i;

// Page footer patterns: "GATCREEK.COM    17" or "17    GATCREEK.COM"
const FOOTER_RE = /^(?:GATCREEK\.COM\s+\d+|\d+\s+GATCREEK\.COM)\s*$/i;

// Lines to skip entirely
const SKIP_RE =
  /^(?:WHOLESALE PRICE LIST|PRODUCT NAME\t|Option Pricing|Case Goods|Extra Shelf|Reverse Door|Alternate Hardware|Wire Management|Contrasting Finishes|Contrasting Table Base|Contrasting Drawer|Contrasting Interior|Contrasting Doors|Contrasting Top|Bed Options|2 Drawer Storage|4 Drawer Storage|Trundle Mattress|Fabric Options|Customer's Own Material|Paint Options|Custom Paint|Our Warranty|Should you|please notify|use within|Measurements|Solid wood|all measurements|Manufacturing Lead Time|Your acknowledgement|the first day|orders on time|Distribution Policy|Gat Creek manufactures|offer an attractive|enforce a unilateral|MAP Policy:|MRP Policy:|will immediately|Our MAP and MRP|over 100 days|Gat Creek reserves|detrimental|Policies, as they|shall constitute|policy\. Gat Creek|to these policies|regarding the|JANUARY \d|Wholesale Price List$)/i;

// Custom Shop section header — stop the wholesale parser here
const CUSTOM_SHOP_START_RE =
  /CUSTOM SHOP|DINING TABLES BUILT|HOW CUSTOM SHOP|CUSTOM\nshop|GET WHAT YOU WANT/i;

function parseWholesaleTable(lines: PLine[]): ParsedGatCreekProduct[] {
  const products: ParsedGatCreekProduct[] = [];
  let headerColumns: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text.trim();
    if (!line) continue;

    if (CUSTOM_SHOP_START_RE.test(line)) break;

    if (/^PRODUCT NAME\t/i.test(line)) {
      headerColumns = line.split("\t").map((c) => c.trim().toUpperCase());
      continue;
    }

    if (FOOTER_RE.test(line) || SKIP_RE.test(line)) continue;

    const tabs = line.split("\t").map((v) => v.trim());
    if (tabs.length < 3) continue;

    let skuIdx = -1;
    for (let j = 1; j < tabs.length; j++) {
      if (/^\d{4,6}$/.test(tabs[j])) {
        skuIdx = j;
        break;
      }
    }
    if (skuIdx < 0) continue;

    const description = tabs[0];
    const size = skuIdx > 1 ? tabs[1] : null;
    const sku = tabs[skuIdx];
    const priceValues = tabs.slice(skuIdx + 1);

    const prices = priceValues.map((v) => {
      const n = parseCurrency(v);
      return isNaN(n) ? null : n;
    });

    if (prices.length === 0 || prices.every((p) => p === null)) continue;

    const speciesPrices = mapPricesToSpecies(prices, headerColumns);

    products.push({
      itemNumber: sku,
      description,
      size,
      pricingType: "SPECIES",
      pageNumber: lines[i].page,
      speciesPrices,
      matrixPrices: null,
      roundPrices: null,
      tableStyle: null,
      tableVariant: null,
      contrastingBaseSurcharge: null,
      leafInfo: null,
    });
  }

  return products;
}

/**
 * Map an array of price values to species, using the count
 * and the known header column order as hints.
 *
 * Observed patterns:
 *   5 prices -> Ash, Cherry, Maple, Walnut, Paint  (full row)
 *   4 prices -> Ash, Cherry, Walnut, Paint  (no Maple, e.g. Bella Chair)
 *   3 prices -> Ash, Cherry, Walnut  (no Maple, no Paint, e.g. Wellesley)
 */
function mapPricesToSpecies(
  prices: (number | null)[],
  headerColumns: string[],
): ParsedGatCreekProduct["speciesPrices"] {
  const hasMapleHeader = headerColumns.includes("MAPLE");
  const hasPaintHeader = headerColumns.includes("PAINT");

  switch (prices.length) {
    case 5:
      return {
        ash: prices[0],
        cherry: prices[1],
        maple: prices[2],
        walnut: prices[3],
        paint: prices[4],
      };

    case 4:
      if (hasMapleHeader && hasPaintHeader) {
        return {
          ash: prices[0],
          cherry: prices[1],
          maple: null,
          walnut: prices[2],
          paint: prices[3],
        };
      }
      return {
        ash: prices[0],
        cherry: prices[1],
        maple: null,
        walnut: prices[2],
        paint: prices[3],
      };

    case 3:
      return {
        ash: prices[0],
        cherry: prices[1],
        maple: null,
        walnut: prices[2],
        paint: null,
      };

    case 2:
      return {
        ash: prices[0],
        cherry: null,
        maple: null,
        walnut: prices[1],
        paint: null,
      };

    case 1:
      return {
        ash: prices[0],
        cherry: prices[0],
        maple: prices[0],
        walnut: prices[0],
        paint: prices[0],
      };

    default:
      return {
        ash: prices[0] ?? null,
        cherry: prices[1] ?? null,
        maple: prices[2] ?? null,
        walnut: prices[3] ?? null,
        paint: prices[4] ?? null,
      };
  }
}

// ─── Custom Shop parser (pages 18-41) ────────────────────────────

// Match "AUSTIN CUSTOM SHOP — Fixed Top Tables"
const CUSTOM_HEADER_RE = /^(\w[\w\s]*?)\s*CUSTOM SHOP\s*[—–-]\s*(.+)$/i;

// Species headers in the matrix grids
const SPECIES_HEADER_RE = /^(?:ASH\s*\/\s*CHERRY\s*\/\s*MAPLE|PAINT|WALNUT|SKU LIST)$/i;

/**
 * Normalize a species label like "ASH / CHERRY / MAPLE" to "Ash/Cherry/Maple".
 */
function normalizeSpecies(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s.startsWith("ASH")) return "Ash/Cherry/Maple";
  if (s === "PAINT") return "Paint";
  if (s === "WALNUT") return "Walnut";
  return s;
}

function parseCustomShop(lines: PLine[]): ParsedGatCreekProduct[] {
  const products: ParsedGatCreekProduct[] = [];

  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (CUSTOM_HEADER_RE.test(lines[i].text.trim())) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (/DINING TABLES BUILT/i.test(lines[i].text.trim())) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx === 0) return products;

  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i].text.trim();

    const headerMatch = CUSTOM_HEADER_RE.exec(line);
    if (!headerMatch) {
      i++;
      continue;
    }

    const tableStyle = headerMatch[1].trim();
    const tableVariant = headerMatch[2].trim();
    const sectionPage = lines[i].page;

    i++;
    let contrastingBaseSurcharge: number | null = null;
    let leafInfo: string | null = null;

    while (i < lines.length) {
      const nextLine = lines[i].text.trim();
      if (!nextLine) {
        i++;
        continue;
      }

      const surchargeMatch = nextLine.match(/CONTRASTING TABLE BASE:\s*\$(\d[\d,]*)/i);
      if (surchargeMatch) {
        contrastingBaseSurcharge = parseCurrency(surchargeMatch[1]);
      }

      const leafMatch = nextLine.match(
        /(STANDARD WITH .+?(?:LEAF|LEAVES)(?:\.\s*ADDITIONAL .+?(?:LEAF|LEAVES):\s*\$\d[\d,]*)?)/i,
      );
      if (leafMatch) {
        leafInfo = leafMatch[1].trim();
      }

      if (surchargeMatch || leafMatch) {
        i++;
        continue;
      }

      break;
    }

    const isRound = /round/i.test(tableVariant);

    if (isRound) {
      const { entries, endIdx } = parseRoundSection(lines, i, tableStyle);

      if (entries.length > 0) {
        products.push({
          itemNumber: `CS-${tableStyle.toUpperCase().replace(/\s+/g, "-")}`,
          description: `${tableStyle} Custom Shop — ${tableVariant}`,
          size: null,
          pricingType: "ROUND",
          pageNumber: sectionPage,
          speciesPrices: null,
          matrixPrices: null,
          roundPrices: entries,
          tableStyle,
          tableVariant,
          contrastingBaseSurcharge,
          leafInfo,
        });
      }

      i = endIdx;
    } else if (/extension/i.test(tableVariant)) {
      const { entries, endIdx } = parseExtensionSection(lines, i, tableStyle);

      if (entries.length > 0) {
        products.push({
          itemNumber: `CS-${tableStyle.toUpperCase().replace(/\s+/g, "-")}`,
          description: `${tableStyle} Custom Shop — ${tableVariant}`,
          size: null,
          pricingType: "MATRIX",
          pageNumber: sectionPage,
          speciesPrices: null,
          matrixPrices: entries,
          roundPrices: null,
          tableStyle,
          tableVariant,
          contrastingBaseSurcharge,
          leafInfo,
        });
      }

      i = endIdx;
    } else {
      const { entries, endIdx } = parseFixedTopSection(lines, i, tableStyle);

      if (entries.length > 0) {
        products.push({
          itemNumber: `CS-${tableStyle.toUpperCase().replace(/\s+/g, "-")}`,
          description: `${tableStyle} Custom Shop — ${tableVariant}`,
          size: null,
          pricingType: "MATRIX",
          pageNumber: sectionPage,
          speciesPrices: null,
          matrixPrices: entries,
          roundPrices: null,
          tableStyle,
          tableVariant,
          contrastingBaseSurcharge,
          leafInfo,
        });
      }

      i = endIdx;
    }
  }

  return products;
}

// ─── Fixed Top Table section parser ──────────────────────────────

function parseFixedTopSection(
  lines: PLine[],
  startIdx: number,
  tableStyle: string,
): { entries: MatrixEntry[]; endIdx: number } {
  const entries: MatrixEntry[] = [];
  const skuMap = new Map<string, string>();
  let i = startIdx;
  let currentSpecies = "";
  let lengths: number[] = [];
  let isSkuSection = false;

  while (i < lines.length) {
    const line = lines[i].text.trim();

    if (CUSTOM_HEADER_RE.test(line)) break;

    if (!line || FOOTER_RE.test(line)) {
      i++;
      continue;
    }

    if (/^WHOLESALE PRICE LIST$/i.test(line)) {
      i++;
      continue;
    }

    if (/^ASH\s*\/\s*CHERRY\s*\/\s*MAPLE$/i.test(line)) {
      currentSpecies = "Ash/Cherry/Maple";
      isSkuSection = false;
      i++;
      continue;
    }
    if (/^PAINT$/i.test(line)) {
      currentSpecies = "Paint";
      isSkuSection = false;
      i++;
      continue;
    }
    if (/^WALNUT$/i.test(line)) {
      currentSpecies = "Walnut";
      isSkuSection = false;
      i++;
      continue;
    }
    if (/^SKU LIST$/i.test(line)) {
      isSkuSection = true;
      currentSpecies = "SKU";
      i++;
      continue;
    }

    if (/^LENGTH$/i.test(line)) {
      i++;
      while (i < lines.length && !lines[i].text.trim()) i++;
      if (i < lines.length) {
        lengths = parseDimensionRow(lines[i].text.trim());
      }
      i++;
      continue;
    }

    if (/^WIDTH$/i.test(line)) {
      i++;
      continue;
    }

    const rowLine = line.replace(/^WIDTH/i, "");
    const tabs = rowLine.split("\t").map((v) => v.trim());
    if (tabs.length < 2) {
      i++;
      continue;
    }

    const widthMatch = tabs[0].match(/^(\d+(?:\.\d+)?)"?$/);
    if (!widthMatch) {
      i++;
      continue;
    }

    const width = Number.parseFloat(widthMatch[1]);
    const values = tabs.slice(1);

    if (!currentSpecies || lengths.length === 0) {
      i++;
      continue;
    }

    if (isSkuSection) {
      for (let j = 0; j < Math.min(values.length, lengths.length); j++) {
        const sku = values[j].trim();
        if (sku && /^\d+$/.test(sku)) {
          skuMap.set(`${width}x${lengths[j]}`, sku);
        }
      }
    } else {
      for (let j = 0; j < Math.min(values.length, lengths.length); j++) {
        const cost = parseCurrency(values[j]);
        if (!isNaN(cost)) {
          entries.push({
            species: currentSpecies,
            width,
            length: lengths[j],
            cost,
            sku: null,
          });
        }
      }
    }

    i++;
  }

  for (const entry of entries) {
    const key = `${entry.width}x${entry.length}`;
    const sku = skuMap.get(key);
    if (sku) entry.sku = sku;
  }

  return { entries, endIdx: i };
}

// ─── Extension Table section parser ──────────────────────────────

function parseExtensionSection(
  lines: PLine[],
  startIdx: number,
  tableStyle: string,
): { entries: MatrixEntry[]; endIdx: number } {
  const entries: MatrixEntry[] = [];
  const skuMap = new Map<string, string>();
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i].text.trim();
    if (CUSTOM_HEADER_RE.test(line)) break;
    if (/^ASH\s*\/\s*CHERRY\s*\/\s*MAPLE/i.test(line)) break;
    i++;
  }
  if (i >= lines.length) return { entries, endIdx: i };

  const block1 = parseExtensionBlock(lines, i, ["Ash/Cherry/Maple", "Paint"]);
  entries.push(...block1.entries);
  i = block1.endIdx;

  while (i < lines.length) {
    const line = lines[i].text.trim();
    if (CUSTOM_HEADER_RE.test(line)) break;
    if (/^WALNUT/i.test(line)) break;
    i++;
  }
  if (i < lines.length && /^WALNUT/i.test(lines[i].text.trim())) {
    const block2 = parseExtensionBlock(lines, i, ["Walnut", "SKU"]);
    for (const entry of block2.entries) {
      if (entry.species === "SKU") {
        skuMap.set(`${entry.width}x${entry.length}`, String(entry.cost));
      } else {
        entries.push(entry);
      }
    }
    i = block2.endIdx;
  }

  for (const entry of entries) {
    const key = `${entry.width}x${entry.length}`;
    const sku = skuMap.get(key);
    if (sku) entry.sku = sku;
  }

  return { entries, endIdx: i };
}

function parseExtensionBlock(
  lines: PLine[],
  startIdx: number,
  speciesLabels: [string, string],
): { entries: MatrixEntry[]; endIdx: number } {
  const entries: MatrixEntry[] = [];
  let i = startIdx;

  // Skip the species header line
  i++;

  while (i < lines.length && !lines[i].text.trim()) i++;
  if (i < lines.length && /LENGTH/i.test(lines[i].text)) i++;

  while (i < lines.length && !lines[i].text.trim()) i++;
  if (i >= lines.length) return { entries, endIdx: i };

  const lengthLine = lines[i].text.trim();
  const allLengths = parseDimensionRow(lengthLine);
  i++;

  const halfLen = Math.floor(allLengths.length / 2);
  const lengths1 = allLengths.slice(0, halfLen);
  const lengths2 = allLengths.slice(halfLen);

  while (i < lines.length) {
    const line = lines[i].text.trim();

    if (!line || FOOTER_RE.test(line)) {
      i++;
      continue;
    }
    if (CUSTOM_HEADER_RE.test(line)) break;
    if (/^(?:WALNUT|ASH|PAINT|SKU LIST)/i.test(line) && !line.includes("$")) break;

    if (/^WIDTH\s*$/i.test(line)) {
      i++;
      continue;
    }
    if (/^WIDTH\tWIDTH\s*$/i.test(line)) {
      i++;
      continue;
    }

    const widthLineMatch = line.match(/^(\d+)"?\s*\t?\s*\d*"?$/);
    if (widthLineMatch) {
      const width = Number.parseFloat(widthLineMatch[1]);
      i++;

      while (i < lines.length && !lines[i].text.trim()) i++;
      if (i >= lines.length) break;

      const priceLine = lines[i].text.trim();
      if (/^WIDTH/i.test(priceLine)) continue;

      const tabs = priceLine.split("\t").map((v) => v.trim());
      const vals1 = tabs.slice(0, halfLen);
      const vals2 = tabs.slice(halfLen);

      for (let j = 0; j < Math.min(vals1.length, lengths1.length); j++) {
        const cost = parseCurrency(vals1[j]);
        if (!isNaN(cost)) {
          entries.push({
            species: speciesLabels[0],
            width,
            length: lengths1[j],
            cost,
            sku: null,
          });
        } else if (speciesLabels[0] === "SKU" || speciesLabels[1] === "SKU") {
          if (/^\d+$/.test(vals1[j])) {
            entries.push({
              species: speciesLabels[0],
              width,
              length: lengths1[j],
              cost: Number.parseInt(vals1[j]),
              sku: vals1[j],
            });
          }
        }
      }

      for (let j = 0; j < Math.min(vals2.length, lengths2.length); j++) {
        if (speciesLabels[1] === "SKU") {
          const skuVal = vals2[j].trim();
          if (/^\d+$/.test(skuVal)) {
            entries.push({
              species: "SKU",
              width,
              length: lengths2[j],
              cost: Number.parseInt(skuVal),
              sku: skuVal,
            });
          }
        } else {
          const cost = parseCurrency(vals2[j]);
          if (!isNaN(cost)) {
            entries.push({
              species: speciesLabels[1],
              width,
              length: lengths2[j],
              cost,
              sku: null,
            });
          }
        }
      }

      i++;
      continue;
    }

    i++;
  }

  return { entries, endIdx: i };
}

// ─── Round Table section parser ──────────────────────────────────

function parseRoundSection(
  lines: PLine[],
  startIdx: number,
  tableStyle: string,
): { entries: RoundEntry[]; endIdx: number } {
  const entries: RoundEntry[] = [];
  const skuMap = new Map<number, string>();
  let i = startIdx;
  let currentSpecies = "";
  let isSkuSection = false;
  let pendingValue: string | null = null;

  while (i < lines.length) {
    const line = lines[i].text.trim();

    if (CUSTOM_HEADER_RE.test(line)) break;

    if (!line || FOOTER_RE.test(line)) {
      i++;
      continue;
    }

    if (/^ASH\s*\/\s*CHERRY\s*\/\s*MAPLE$/i.test(line)) {
      currentSpecies = "Ash/Cherry/Maple";
      isSkuSection = false;
      pendingValue = null;
      i++;
      continue;
    }
    if (/^PAINT$/i.test(line)) {
      currentSpecies = "Paint";
      isSkuSection = false;
      pendingValue = null;
      i++;
      continue;
    }
    if (/^WALNUT$/i.test(line)) {
      currentSpecies = "Walnut";
      isSkuSection = false;
      pendingValue = null;
      i++;
      continue;
    }
    if (/^SKU LIST$/i.test(line)) {
      isSkuSection = true;
      currentSpecies = "SKU";
      pendingValue = null;
      i++;
      continue;
    }

    if (/^DIAMETER$/i.test(line)) {
      i++;
      continue;
    }

    const tabs = line.split("\t").map((v) => v.trim());

    const maybeValueOnly = tabs[0];
    if (tabs.length === 1 && !maybeValueOnly.includes('"')) {
      if (/^\$/.test(maybeValueOnly) || /^\d{4,6}$/.test(maybeValueOnly)) {
        pendingValue = maybeValueOnly;
        i++;
        continue;
      }
    }

    const diamMatch = tabs[0].match(/^(\d+)"?$/);
    if (diamMatch) {
      const diameter = Number.parseFloat(diamMatch[1]);
      const value = tabs.length > 1 ? tabs[1] : pendingValue;
      pendingValue = null;

      if (value) {
        if (isSkuSection) {
          if (/^\d+$/.test(value)) {
            skuMap.set(diameter, value);
          }
        } else if (currentSpecies && currentSpecies !== "SKU") {
          const cost = parseCurrency(value);
          if (!isNaN(cost)) {
            entries.push({
              species: currentSpecies,
              diameter,
              cost,
              sku: null,
            });
          }
        }
      }
    }

    i++;
  }

  for (const entry of entries) {
    const sku = skuMap.get(entry.diameter);
    if (sku) entry.sku = sku;
  }

  return { entries, endIdx: i };
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseDimensionRow(line: string): number[] {
  const tabs = line.split("\t").map((v) => v.trim());
  const dims: number[] = [];
  for (const t of tabs) {
    const match = t.match(/^(\d+(?:\.\d+)?)"?$/);
    if (match) {
      dims.push(Number.parseFloat(match[1]));
    }
  }
  return dims;
}
