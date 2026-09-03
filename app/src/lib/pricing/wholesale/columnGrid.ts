// /app/src/lib/pricing/wholesale/columnGrid.ts
//
// The column-transposed price-grid reader. One layout, many vendors.
//
// The layout: a page holds several STYLE COLUMNS side by side, and every row is
// labelled. Reading down a column gives one style; reading across a row gives
// one attribute for every style on the page.
//
//   STYLE NUMBER:      1034      1035      1036
//   STYLE NAME:        Nova      Orion     Pike
//   Grade: B           $804      $601      $712
//   Grade: C           $839      $636      $747
//
// Raw pdf-parse output is unusable here — glyphs butt together with no
// delimiter, so "$804$601$712" arrives as one token. `columnAwarePageRenderer`
// rebuilds the columns from glyph x-coordinates and inserts real tabs, which is
// why every vendor on this layout must render through it.
//
// Everything vendor-specific is in the profile. This file knows about tabs,
// columns and pages; it does not know any vendor's name.

import { columnAwarePageRenderer } from "../pdfUtils";
import type { ParsedWholesaleProduct } from "../wesleyHallParser";
import type { StyleOption, WholesaleVendorProfile } from "./profile";

/* eslint-disable @typescript-eslint/no-require-imports */
const pdf = require("pdf-parse");

/** Money cell to a number, or null when the vendor's book says "no price". */
export function parseMoney(raw: string, emptyCells: readonly string[]): number | null {
  const trimmed = raw.trim();
  if (emptyCells.includes(trimmed)) return null;
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Dimension cell to a number, carrying the vulgar fractions these books print
 * ("31 1/2" -> 31.5). Returns null rather than 0 for an absent value: 0 is a
 * real width and would be indistinguishable from "not stated".
 */
export function parseDimension(raw: string, emptyCells: readonly string[]): number | null {
  const s = raw.trim();
  if (!s || emptyCells.includes(s)) return null;
  const m = /^(\d+)(?:\s+(\d+)\/(\d+))?/.exec(s);
  if (!m) return null;
  let val = Number.parseInt(m[1], 10);
  if (m[2] && m[3]) {
    const denom = Number.parseInt(m[3], 10);
    if (denom !== 0) val += Number.parseInt(m[2], 10) / denom;
  }
  return Number.isFinite(val) ? val : null;
}

/** Values after the label: everything past the first tab. */
function cells(line: string): string[] {
  return line
    .split("\t")
    .slice(1)
    .map((c) => c.trim());
}

/** Values after a nested label: everything past the second tab. */
function deepCells(line: string): string[] {
  return line
    .split("\t")
    .slice(2)
    .map((c) => c.trim());
}

/** Split a page into one chunk per style grid, starting at each header row. */
function splitIntoGrids(text: string, header: RegExp): string[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i])) starts.push(i);
  }
  return starts.map((start, idx) =>
    lines.slice(start, idx + 1 < starts.length ? starts[idx + 1] : lines.length).join("\n"),
  );
}

/**
 * Strip a section heading the renderer glued onto a row label.
 *
 * Done before every label match, so profiles can anchor their patterns at ^ and
 * still catch the glued rows. Without it an anchored pattern misses exactly the
 * rows that follow a heading, and the miss reads as the option being rare rather
 * than as a parsing failure.
 */
function deglue(label: string, profile: WholesaleVendorProfile): string {
  let out = label.trim();
  for (const h of profile.gluedSectionHeaders ?? []) {
    if (out.startsWith(h)) out = out.slice(h.length).trim();
  }
  return out;
}

interface Collected {
  rows: Record<string, string[]>;
  grades: Record<string, string[]>;
  /** Option row values, keyed by the option's index in the profile. */
  optionCells: Record<number, string[]>;
}

/** Walk a grid's lines into a row map and a grade map, both column-indexed. */
function collectRows(lines: string[], profile: WholesaleVendorProfile): Collected {
  const rows: Record<string, string[]> = {};
  const grades: Record<string, string[]> = {};
  const optionCells: Record<number, string[]> = {};

  for (const line of lines) {
    if (!line.includes("\t")) continue;
    const label = deglue(line.split("\t")[0], profile);

    const grade = profile.gradeOfRow(label);
    if (grade) {
      grades[grade] = cells(line);
      continue;
    }

    const optIdx = (profile.options ?? []).findIndex((o) => o.match.test(label));
    if (optIdx >= 0) {
      optionCells[optIdx] = cells(line);
      continue;
    }

    // A deep row's label is nested, so match against the whole line.
    const spec = profile.rows.find((r) => r.match.test(r.deep ? line : label));
    if (spec) rows[spec.key] = spec.deep ? deepCells(line) : cells(line);
  }

  return { rows, grades, optionCells };
}

/** One column's prices, in the vendor's declared ladder order. */
function gradePricesFor(
  column: number,
  grades: Record<string, string[]>,
  profile: WholesaleVendorProfile,
): { grade: string; cost: number }[] {
  const out: { grade: string; cost: number }[] = [];
  for (const spec of profile.grades) {
    const cost = parseMoney((grades[spec.code] || [])[column] || "", profile.emptyCells);
    if (cost === null) continue;
    out.push({ grade: spec.code, cost });
    // COM is not a separate price — it is the same rung, named for the customer
    // supplying the material.
    if (profile.comGrade && spec.code === profile.comGrade) {
      out.push({ grade: "COM", cost });
    }
  }
  return out;
}

/**
 * One column's options, as the book states them for that frame.
 *
 * Three outcomes per option, and the difference between the last two is the
 * whole point: a style that CANNOT take an option must not appear to take it
 * for free.
 *
 *   row absent, or cell is a no-price token  -> not applicable, omitted
 *   cell is an included token ("N/C")        -> applicable, surcharge 0, standard
 *   cell is a number                         -> applicable, that surcharge
 */
function optionsFor(
  column: number,
  optionCells: Record<number, string[]>,
  profile: WholesaleVendorProfile,
): StyleOption[] {
  const out: StyleOption[] = [];
  (profile.options ?? []).forEach((spec, i) => {
    const raw = (optionCells[i] || [])[column];
    if (raw === undefined) return;
    const cell = raw.trim();
    if (!cell || profile.emptyCells.includes(cell)) return;

    const included = (spec.includedTokens ?? []).some(
      (t) =>
        cell.toUpperCase() === t.toUpperCase() ||
        cell.toUpperCase().endsWith(`- ${t.toUpperCase()}`),
    );
    const cost = included ? 0 : parseMoney(cell, profile.emptyCells);
    // A cell that is neither a price nor an included-token is prose the book put
    // in a price column ("see front of pricelist"). Not a zero -- unknown.
    if (cost === null) return;

    out.push({
      groupName: spec.groupName,
      optionName: spec.optionName,
      surcharge: cost,
      surchargeType: spec.surchargeType ?? "FLAT",
      isStandard: included,
      sortOrder: spec.sortOrder ?? i,
    });
  });
  return out;
}

function parseGrid(
  chunk: string,
  pageNumber: number,
  profile: WholesaleVendorProfile,
): ParsedWholesaleProduct[] {
  const lines = chunk.split("\n");
  const { rows, grades, optionCells } = collectRows(lines, profile);
  const headerCells = rows.style || [];
  const products: ParsedWholesaleProduct[] = [];

  for (let col = 0; col < headerCells.length; col++) {
    const cell = (headerCells[col] || "").trim();
    if (!cell || profile.emptyCells.includes(cell)) continue;

    const gradePrices = gradePricesFor(col, grades, profile);
    // A column with no prices is a layout artifact, not a style.
    if (gradePrices.length === 0) continue;

    const skus = profile.expandSkus ? profile.expandSkus(cell, lines, col) : [cell];
    const styleOptions = optionsFor(col, optionCells, profile);
    const dim = (key: string) => parseDimension(rows[key]?.[col] || "", profile.emptyCells);

    for (const styleNumber of skus) {
      products.push({
        styleNumber,
        styleName: (rows.name?.[col] || "").trim(),
        description: (rows.desc?.[col] || "").trim(),
        leatherStyleNumber: null,
        finish: null,
        decorativeFinishSurcharge: null,
        standardPillows: null,
        gradeRiser: null,
        standardSeat: null,
        standardBack: null,
        springDownBdbSurcharge: null,
        comfortDownBdbSurcharge: null,
        yardagePlain: dim("yardage"),
        yardagePattern: null,
        yardageRepeat: null,
        gradePrices,
        overallWidth: dim("width"),
        overallDepth: dim("depth"),
        overallHeight: dim("height"),
        seatHeight: dim("seatHeight"),
        seatDepth: dim("seatDepth"),
        armHeight: dim("armHeight"),
        pageNumber,
        styleOptions,
      } as ParsedWholesaleProduct);
    }
  }

  return products;
}

/**
 * Parse already-rendered text (page markers + tabs) for one vendor.
 *
 * Exported separately from the PDF entry point so tests drive the parsing with a
 * text fixture and never need a binary. That split is why these are testable at
 * all — a fixture is readable in a diff, a PDF is not.
 */
export function parseRenderedGrid(
  text: string,
  profile: WholesaleVendorProfile,
): ParsedWholesaleProduct[] {
  const products: ParsedWholesaleProduct[] = [];
  const segments = text.split(/<<PAGE:(\d+)>>\n/);

  for (let i = 1; i < segments.length; i += 2) {
    const pageNumber = Number.parseInt(segments[i], 10);
    const pageText = segments[i + 1] || "";

    if (profile.pageRequires && !profile.pageRequires.every((re) => re.test(pageText))) {
      continue;
    }
    for (const chunk of splitIntoGrids(pageText, profile.gridHeader)) {
      products.push(...parseGrid(chunk, pageNumber, profile));
    }
  }

  return products;
}

/** Render a price-book PDF through the column-aware renderer, then parse it. */
export async function extractWholesaleGrid(
  pdfBuffer: Buffer,
  profile: WholesaleVendorProfile,
): Promise<ParsedWholesaleProduct[]> {
  const data = await pdf(pdfBuffer, {
    pagerender: (pageData: { pageNumber: number }) =>
      columnAwarePageRenderer(pageData).then(
        (text: string) => `<<PAGE:${pageData.pageNumber}>>\n${text}`,
      ),
  });
  return parseRenderedGrid(data.text, profile);
}
