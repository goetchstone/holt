// /app/src/lib/pricing/ekornesParser.ts
//
// Parses the Ekornes (Stressless) MRP price book PDF.
// Handles multiple product formats: recliners (4-grade), sofas (4-grade with
// Paloma Special), Admiral (MAP/MRP dual-column), Paloma-only families
// (Max/Mike/Sam), dining (single-price), mattresses, and accessories.

import { extractPdfTextWithPages } from "./pdfUtils";

// ─── Exported types ──────────────────────────────────────────────

export interface ParsedEkornesGradePrice {
  grade: string; // Expanded tier: Batick, Fabric, Paloma, Dinamica, Velaro, Noblesse, MAP, FLAT
  mrp: number;
}

export interface ParsedEkornesProduct {
  materialNumber: string;
  description: string;
  collection: string;
  model: string;
  base: string;
  variant: string;
  gradePrices: ParsedEkornesGradePrice[];
  pageNumber: number;
}

export interface ParsedEkornesFabric {
  fabricName: string; // Material line: "Batick", "Paloma", "Aster", "Dinamica", etc.
  colorName: string; // Color: "Black", "Fog", "Charcoal"
  colorCode: string; // Vendor color number: "093 19", "094 37", "550 13"
  grade: string; // Grade tier: Batick, Paloma, Velaro, Noblesse, Fabric, Dinamica
}

export interface ParsedEkornesData {
  products: ParsedEkornesProduct[];
  collections: string[];
  gradeTiers: string[];
  fabrics: ParsedEkornesFabric[];
}

// ─── Grade column detection ──────────────────────────────────────

interface GradeColumnMap {
  columns: { index: number; code: string }[];
}

// Patterns to match header columns to tier codes.
// Order matters: more specific patterns must come before less specific ones.
const TIER_PATTERNS: { pattern: RegExp; code: string }[] = [
  { pattern: /admiral\s*specials/i, code: "MAP" },
  { pattern: /batick\/paloma/i, code: "FLAT" },
  { pattern: /calido\/daisy\/dinamica/i, code: "FLAT" },
  { pattern: /batick\s*&\s*fabrics/i, code: "BF" },
  { pattern: /paloma\s*special/i, code: "PS" },
  { pattern: /dinamica\s*&\s*paloma/i, code: "DP" },
  { pattern: /&\s*paloma(?!\s*special)/i, code: "DP" },
  { pattern: /velaro/i, code: "VL" },
  { pattern: /noblesse/i, code: "NB" },
  { pattern: /^paloma$/i, code: "PAL" },
  { pattern: /^mrp$/i, code: "FLAT" },
];

function parseCurrency(s: string): number {
  const cleaned = s.replace(/[$,\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ─── Grade tier expansion ────────────────────────────────────────

// The PDF groups materials into combined columns (e.g. "Batick & Fabrics",
// "Dinamica & Paloma"). This function expands those into individual grades
// so the system stores separate tiers for each material.
//
// Expansion rules:
//   BF (Batick & Fabrics)  -> BAT + FAB at the same price
//   DP (Dinamica & Paloma) -> DIN + PAL at the same price (PAL omitted if PS exists)
//   PS (Paloma Special)    -> Paloma (separate price column, e.g. Emily V2)
//   PAL (standalone Paloma) -> Paloma (Admiral page header)
//   VL -> VEL, NB -> NOB, MAP and FLAT pass through unchanged

function expandGradeTiers(gradePrices: ParsedEkornesGradePrice[]): ParsedEkornesGradePrice[] {
  const expanded: ParsedEkornesGradePrice[] = [];
  const hasPalomaSpecial = gradePrices.some((gp) => gp.grade === "PS");

  for (const gp of gradePrices) {
    switch (gp.grade) {
      case "BF":
        expanded.push({ grade: "Batick", mrp: gp.mrp });
        expanded.push({ grade: "Fabric", mrp: gp.mrp });
        break;
      case "PS":
      case "PAL":
        expanded.push({ grade: "Paloma", mrp: gp.mrp });
        break;
      case "DP":
        expanded.push({ grade: "Dinamica", mrp: gp.mrp });
        if (!hasPalomaSpecial) {
          expanded.push({ grade: "Paloma", mrp: gp.mrp });
        }
        break;
      case "VL":
        expanded.push({ grade: "Velaro", mrp: gp.mrp });
        break;
      case "NB":
        expanded.push({ grade: "Noblesse", mrp: gp.mrp });
        break;
      default:
        expanded.push(gp);
        break;
    }
  }

  return expanded;
}

// ─── Fabric & leather catalog parser ─────────────────────────────

// Maps the material prefix (first 3 digits of color code) to its grade tier.
// Leathers: Batick (093), Paloma (094), Noblesse (096), Velaro (098)
// Fabrics: Aster (506), Calido (579), Daisy (500), Dinamica (550), Lilly (518)
const MATERIAL_PREFIX_GRADE: Record<string, { grade: string; fabricName: string }> = {
  "093": { grade: "Batick", fabricName: "Batick" },
  "094": { grade: "Paloma", fabricName: "Paloma" },
  "096": { grade: "Noblesse", fabricName: "Noblesse" },
  "098": { grade: "Velaro", fabricName: "Velaro" },
  "506": { grade: "Fabric", fabricName: "Aster" },
  "579": { grade: "Fabric", fabricName: "Calido" },
  "500": { grade: "Fabric", fabricName: "Daisy" },
  "550": { grade: "Dinamica", fabricName: "Dinamica" },
  "518": { grade: "Fabric", fabricName: "Lilly" },
};

// Parse color entries from the leather guide (page 4) and fabric guide (page 5).
// Lines follow the pattern: "093  19  Black" or "093 73  Atlantic Blue"
function parseFabricCatalog(pages: { pageNum: number; lines: string[] }[]): ParsedEkornesFabric[] {
  const fabrics: ParsedEkornesFabric[] = [];
  const catalogPages = pages.filter((p) => p.pageNum >= 4 && p.pageNum <= 5);

  for (const page of catalogPages) {
    for (const line of page.lines) {
      // Match lines like "093 73  Atlantic Blue" or "550 61 Berry Red"
      // Pattern: 3-digit prefix, space(s), 2-digit color number, space(s), color name
      const matches = line.matchAll(
        /(\d{3})\s+(\d{2})\s+([A-Z][A-Za-z\s]+?)(?=\t|\d{3}\s|\s{3,}|$)/g,
      );
      for (const m of matches) {
        const prefix = m[1];
        const colorNum = m[2];
        const colorName = m[3].trim();

        const mapping = MATERIAL_PREFIX_GRADE[prefix];
        if (!mapping) continue;
        if (!colorName || colorName.length < 2) continue;
        // Skip header words that look like color names
        if (/^(No|Color|LEATHER|FABRIC|GUIDE|PER SQ|NOTE|WOOD)$/i.test(colorName)) continue;

        fabrics.push({
          fabricName: mapping.fabricName,
          colorName,
          colorCode: `${prefix} ${colorNum}`,
          grade: mapping.grade,
        });
      }
    }
  }

  return fabrics;
}

// ─── Main parser ─────────────────────────────────────────────────

export async function parseEkornesPriceList(buffer: Buffer): Promise<ParsedEkornesData> {
  const raw = await extractPdfTextWithPages(buffer);
  const allLines = raw.split("\n");

  const products: ParsedEkornesProduct[] = [];
  const collectionsSet = new Set<string>();
  const gradeTiersSet = new Set<string>();

  // Split into pages
  const pages: { pageNum: number; lines: string[] }[] = [];
  let currentPage: { pageNum: number; lines: string[] } | null = null;

  for (const line of allLines) {
    const pageMatch = line.match(/<<PAGE:(\d+)>>/);
    if (pageMatch) {
      if (currentPage) pages.push(currentPage);
      currentPage = { pageNum: Number.parseInt(pageMatch[1]), lines: [] };
      continue;
    }
    if (currentPage) {
      currentPage.lines.push(line);
    }
  }
  if (currentPage) pages.push(currentPage);

  // Skip non-pricing pages (cover, color guides, indexes, policies, config forms)
  const skipPages = new Set([
    1, 2, 3, 4, 5, 6, 19, 40, 41, 42, 46, 48, 52, 53, 54, 55, 56, 57, 58, 59,
  ]);

  for (const page of pages) {
    if (skipPages.has(page.pageNum)) continue;

    // Some pages contain multiple pricing sections (e.g. accessories).
    // Split into sub-sections at "Stressless\t" boundaries and process each.
    const sections = splitPageIntoSections(page.lines);

    for (const section of sections) {
      const collection = detectCollection(section);
      if (!collection) continue;

      const gradeMap = detectGradeColumns(section);
      if (!gradeMap) continue;

      const sectionProducts = extractProducts(section, collection, gradeMap, page.pageNum);
      for (const p of sectionProducts) {
        p.gradePrices = expandGradeTiers(p.gradePrices);
        products.push(p);
        collectionsSet.add(p.collection);
        for (const gp of p.gradePrices) {
          gradeTiersSet.add(gp.grade);
        }
      }
    }
  }

  // Parse fabric/leather color catalog from pages 4-5
  const fabrics = parseFabricCatalog(pages);

  return {
    products,
    collections: Array.from(collectionsSet).sort((a, b) => a.localeCompare(b)),
    gradeTiers: Array.from(gradeTiersSet).sort((a, b) => a.localeCompare(b)),
    fabrics,
  };
}

// ─── Page section splitting ──────────────────────────────────────

/**
 * Split a page's lines into sub-sections at "Stressless [Name]" boundaries.
 * Pages like the accessories page contain multiple distinct pricing tables
 * (Modern Ottoman, Double Ottoman, Stella Ottoman, etc.).
 */
function splitPageIntoSections(lines: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    // New section starts at "Stressless [Name]" that isn't a measurements header
    const isHeader =
      /^Stressless\s+\S/i.test(line.trim()) &&
      !line.includes("Measurements") &&
      !line.includes("OPTIONS");

    if (isHeader && current.length > 0) {
      // Check if current section has any pricing content (has a header with Item no.)
      const hasPricing = current.some(
        (l) => /item\s*no|material\s*#|^model\t/i.test(l) && !/measurements/i.test(l),
      );
      if (hasPricing) {
        sections.push(current);
      }
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    sections.push(current);
  }

  // If no splits occurred, return the whole page as one section
  return sections.length > 0 ? sections : [lines];
}

// ─── Collection / family detection ───────────────────────────────

function detectCollection(lines: string[]): string | null {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i].trim();
    const m = line.match(/^Stressless\s+(.+)/i);
    if (m) {
      let name = m[1].trim();
      if (name.includes("Measurements") || name.includes("OPTIONS")) continue;
      name = name.replace(/\s+Family$/i, "").trim();
      if (/^(Accessories|Batteries|Hard Floor|Cleaning|Swivel|Elevator)/i.test(name)) continue;
      // Clean up collection names
      name = name.replace(/\s+Configuration Examples?$/i, "").trim();
      // Remove tab-separated suffixes (e.g. "Admiral Family\tMAP\tMRP")
      name = name.split("\t")[0].trim();
      // Strip " MRP" suffix (e.g. "Emily V2 Steel MRP")
      name = name.replace(/\s+MRP$/i, "").trim();
      // Normalize sub-variant names to parent family
      // "Emily V2 Steel", "Emily V2 Wide", "Emily V2 Wood" -> "Emily V2"
      name = name.replace(/^(Emily V2)\s+(Steel|Wide|Wood)$/i, "$1");
      name = name.replace(/^(Fiona)\s+(Armless|Wood)$/i, "$1");
      name = name.replace(/^(Mary V2)\s+(Upholstered|Wood)$/i, "$1");
      name = name.replace(/^(Windsor)\s+(High-Back|Low-Back)$/i, "$1");
      name = name.replace(/^(Buckingham)\s+(Low-back|High-back)$/i, "$1");
      name = name.replace(/^(Admiral)\s+Family$/i, "$1");
      if (name.length > 0 && name.length < 40) return name;
    }
  }
  return null;
}

// ─── Grade column detection ──────────────────────────────────────

function detectGradeColumns(lines: string[]): GradeColumnMap | null {
  // The header may span two lines. The previous line often contains
  // the first grade name (e.g. "Batick & Fabrics**"), while the header
  // line has the remaining tiers as tab-separated cells.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Header lines start with "Item no.", "Material #", or "Model"
    if (!/item\s*no|material\s*#|^model\t/i.test(line)) continue;
    if (/measurements/i.test(line)) continue;

    const parts = line.split("\t");
    const columns: { index: number; code: string }[] = [];

    // Build per-column labels by merging the previous line's cells
    const prevParts = i > 0 ? lines[i - 1].split("\t") : [];

    for (let j = 0; j < parts.length; j++) {
      const cell = parts[j].trim();
      const prevCell = j < prevParts.length ? prevParts[j].trim() : "";
      const combined = (prevCell + " " + cell).trim();

      for (const tp of TIER_PATTERNS) {
        if (tp.pattern.test(cell) || (prevCell.length > 2 && tp.pattern.test(combined))) {
          if (!columns.some((c) => c.code === tp.code)) {
            columns.push({ index: j, code: tp.code });
          }
          break;
        }
      }
    }

    if (columns.length > 0) return { columns };

    // Fallback: detect price columns by scanning data rows
    const fallback = detectPriceColumnsByData(lines, i);
    if (fallback) return fallback;
  }

  return null;
}

function detectPriceColumnsByData(lines: string[], headerIdx: number): GradeColumnMap | null {
  const columns: { index: number; code: string }[] = [];
  for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 5); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split("\t");
    for (let j = 0; j < parts.length; j++) {
      if (/^\$[\d,]+$/.test(parts[j].trim()) && !columns.some((c) => c.index === j)) {
        columns.push({ index: j, code: "FLAT" });
      }
    }
    if (columns.length > 0) break;
  }
  return columns.length > 0 ? { columns } : null;
}

// ─── Product extraction ──────────────────────────────────────────

function extractProducts(
  lines: string[],
  collection: string,
  gradeMap: GradeColumnMap,
  pageNumber: number,
): ParsedEkornesProduct[] {
  const products: ParsedEkornesProduct[] = [];

  // Find pricing header line
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if ((/item\s*no|material\s*#/i.test(l) || /^model\t/i.test(l)) && !/measurements/i.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return products;

  // Determine column layout from header
  const headerParts = lines[headerIdx].split("\t").map((s) => s.trim().toLowerCase());
  const hasBase = headerParts.some((h) => h === "base" || h === "leg type" || h === "base type");
  const hasOption = headerParts.some((h) => h === "option" || h === "packaging option");
  const hasVariant = headerParts.some((h) => h === "variant");

  // Find column indices for descriptive fields
  let modelIdx = headerParts.findIndex((h) => h === "model");
  if (modelIdx < 0) modelIdx = 1;

  let baseIdx = -1;
  if (hasBase) {
    baseIdx = headerParts.findIndex((h) => h === "base" || h === "leg type" || h === "base type");
  }

  let optionIdx = -1;
  if (hasOption) {
    optionIdx = headerParts.findIndex((h) => h === "option" || h === "packaging option");
  }

  let variantIdx = -1;
  if (hasVariant) {
    variantIdx = headerParts.findIndex((h) => h === "variant");
  }

  // Parse data rows
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Stop at measurement sections, notes, footers
    if (/measurements\s*\(inches\)/i.test(line)) break;
    if (/^\*{1,2}\s*Fabrics/i.test(line)) break;
    if (/^P:\s*Power/i.test(line)) break;
    if (/^For Stressless/i.test(line)) break;
    if (/^(NOTES|NOTE:|OPTIONS FOR|AVAILABLE|Wood Options)/i.test(line)) break;
    if (/^(RECLINERS|SOFAS|DINING|ACCESSORIES|SLEEP)\s*\d*\s*$/i.test(line)) break;
    if (/^O\s+\d+\.\d+\.\d+/i.test(line)) break;
    if (/^\*\s*\w/.test(line) && !/^\d/.test(line)) break;
    if (/^Paloma Special/i.test(line)) break;

    const parts = line.split("\t");
    if (parts.length < 2) continue;

    // First column must start with digits (material number)
    const matNumRaw = parts[0].trim();
    if (!/^\d{5,}/.test(matNumRaw)) continue;

    // Clean material number (take first before "or")
    const cleanMatNum = matNumRaw.replace(/\s+or\s+\d+/g, "").trim();

    // Extract prices from mapped columns
    const gradePrices: ParsedEkornesGradePrice[] = [];
    for (const col of gradeMap.columns) {
      if (col.index < parts.length) {
        const priceStr = parts[col.index].trim();
        if (/^\$[\d,]+/.test(priceStr)) {
          const mrp = parseCurrency(priceStr);
          if (mrp > 0) {
            gradePrices.push({ grade: col.code, mrp });
          }
        }
      }
    }

    // If no prices found from mapped columns, scan for any $ value
    if (gradePrices.length === 0) {
      for (let j = 1; j < parts.length; j++) {
        const priceStr = parts[j].trim();
        if (/^\$[\d,]+$/.test(priceStr)) {
          const mrp = parseCurrency(priceStr);
          if (mrp > 0) {
            gradePrices.push({ grade: "FLAT", mrp });
            break;
          }
        }
      }
      if (gradePrices.length === 0) continue;
    }

    // Extract descriptive fields.
    // When header is "Model\tVariant" (no Item no.), the material number is in
    // column 0 and model is the same column. Use column 1+ for description.
    let model = modelIdx >= 0 && modelIdx < parts.length ? parts[modelIdx].trim() : "";
    // If model column is the same as the item number column, use the next column
    if (model === cleanMatNum || /^\d{5,}/.test(model)) {
      model = modelIdx + 1 < parts.length ? parts[modelIdx + 1].trim() : "";
    }
    const base =
      baseIdx >= 0 && baseIdx < parts.length && !parts[baseIdx].trim().startsWith("$")
        ? parts[baseIdx].trim()
        : "";
    const variant =
      variantIdx >= 0 && variantIdx < parts.length && !parts[variantIdx].trim().startsWith("$")
        ? parts[variantIdx].trim()
        : optionIdx >= 0 && optionIdx < parts.length && !parts[optionIdx].trim().startsWith("$")
          ? parts[optionIdx].trim()
          : "";

    // Deduplicate and filter description parts
    const descParts: string[] = [];
    for (const s of [model, base, variant]) {
      if (!s || s.startsWith("$") || /^\d{5,}/.test(s)) continue;
      if (descParts.includes(s)) continue;
      descParts.push(s);
    }
    const description = descParts.join(" ").trim() || collection;

    products.push({
      materialNumber: cleanMatNum,
      description,
      collection,
      model: model || collection,
      base,
      variant,
      gradePrices,
      pageNumber,
    });
  }

  return products;
}
