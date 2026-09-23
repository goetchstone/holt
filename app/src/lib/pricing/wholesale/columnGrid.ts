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

import { columnAwarePageRenderer, parsePdf, readPdfTextItems } from "../pdfUtils";
import type { ParsedWholesaleProduct } from "../wesleyHallParser";
import type { ParseDiagnostic, ParseResult } from "../pricingTypes";
import type {
  EditionExpectation,
  LayoutText,
  StyleOption,
  WholesaleVendorProfile,
} from "./profile";

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
  // A cell may carry its axis letter ("D  38\""), as some books print depth.
  const m = /^(?:[WDH]\s+)?(\d+)(?:\s+(\d+)\/(\d+))?/.exec(s);
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
    if (!spec) continue;
    if (spec.inline) {
      rows[spec.key] = line.split("\t").map((c) => c.trim().replace(spec.match, "").trim());
    } else {
      rows[spec.key] = spec.deep ? deepCells(line) : cells(line);
    }
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
/**
 * Classify one option cell against the book's own legend.
 *
 * Four outcomes, and the distinctions matter to a designer:
 *
 *   blank / row absent  -> the book says nothing; no row at all
 *   "--" (Not Available)-> explicitly not offered on this frame; kept as a row
 *                          with isAvailable=false so the UI can grey it with a
 *                          reason rather than leave it silently missing
 *   "Standard"          -> the frame SHIPS with it
 *   "N/C"               -> a choice that costs nothing -- NOT the same as
 *                          standard, and saying so would tell a customer
 *                          something is fitted when it is merely free to add
 *   a number            -> that surcharge
 */
function classifyCell(
  raw: string | undefined,
  spec: { includedTokens?: readonly string[] },
  emptyCells: readonly string[],
): { surcharge: number; isStandard: boolean; isAvailable: boolean } | null {
  if (raw === undefined) return null;
  const cell = raw.trim();
  if (!cell) return null;
  if (emptyCells.includes(cell)) return { surcharge: 0, isStandard: false, isAvailable: false };
  if (/^(Standard|Included|STD)$/i.test(cell)) {
    return { surcharge: 0, isStandard: true, isAvailable: true };
  }
  if (/^(N\/C|No Charge)$/i.test(cell)) {
    return { surcharge: 0, isStandard: false, isAvailable: true };
  }
  for (const t of spec.includedTokens ?? []) {
    if (cell.toUpperCase() === t.toUpperCase()) {
      return { surcharge: 0, isStandard: false, isAvailable: true };
    }
  }
  const money = parseMoney(cell, emptyCells);
  if (money === null) return null; // prose in a price column ("see front of list")
  return { surcharge: money, isStandard: false, isAvailable: true };
}

/** One column's options, as the book states them for that frame. */
function optionsFor(
  column: number,
  optionCells: Record<number, string[]>,
  profile: WholesaleVendorProfile,
): StyleOption[] {
  const out: StyleOption[] = [];
  (profile.options ?? []).forEach((spec, i) => {
    const c = classifyCell((optionCells[i] || [])[column], spec, profile.emptyCells);
    if (!c) return;
    out.push({
      groupName: spec.groupName,
      optionName: spec.optionName,
      surcharge: c.surcharge,
      surchargeType: spec.surchargeType ?? "FLAT",
      isStandard: c.isStandard,
      isAvailable: c.isAvailable,
      requiresTextInput: spec.requiresTextInput ?? false,
      textInputLabel: spec.textInputLabel ?? null,
      sortOrder: spec.sortOrder ?? i,
    });
  });
  return out;
}

/**
 * Leather SKUs print only for the styles that have one, so the row is sparse
 * and the renderer (which drops empty cells) leaves its positions meaningless.
 * Each SKU names its base style instead -- `1344-005-L` is `1344-005`'s -- so
 * it goes to the column whose style number it extends, the longest such, so
 * that `1344-005-L` lands on `1344-005` rather than on a sibling `1344`.
 */
function leatherSkusByStyle(skus: string[], styles: string[]): Map<string, string> {
  const byStyle = new Map<string, string>();
  for (const sku of skus) {
    const owner = styles
      .filter((s) => s && sku.length > s.length && sku.startsWith(s) && /[-\s]/.test(sku[s.length]))
      .sort((a, b) => b.length - a.length)[0];
    if (owner && !byStyle.has(owner)) byStyle.set(owner, sku);
  }
  return byStyle;
}

// Rows read by column position. A row whose cell count is not the style count
// cannot be placed: the renderer drops empty cells, glues neighbours ("Wing w/o
// ButtonsSide Dining Chair"), and can emit a stray leading blank. Read by
// position anyway, its values land on the wrong styles and still look plausible
// -- Sam Moore's July 2026 book shifted descriptions and COM yardage exactly this
// way. Such a row is left unset for the whole grid and reported, not guessed
// (rule 0.1.10).
const POSITIONAL_ROWS = [
  "name",
  "desc",
  "yardage",
  "width",
  "depth",
  "height",
  "seatHeight",
  "seatDepth",
  "armHeight",
];

function parseGrid(
  chunk: string,
  pageNumber: number,
  profile: WholesaleVendorProfile,
): {
  products: ParsedWholesaleProduct[];
  columnsDropped: number;
  columnsUnplaceable: number;
  rowsMisaligned: string[];
} {
  const lines = chunk.split("\n");
  const { rows, grades, optionCells } = collectRows(lines, profile);
  const headerCells = rows.style || [];
  const products: ParsedWholesaleProduct[] = [];
  let columnsDropped = 0;
  let columnsUnplaceable = 0;

  const rowsMisaligned = POSITIONAL_ROWS.filter(
    (key) => rows[key] && rows[key].length !== headerCells.length,
  );
  for (const key of rowsMisaligned) delete rows[key];
  const leatherByStyle = leatherSkusByStyle(
    rows.leatherStyleNumber ?? [],
    headerCells.map((c) => c.trim()),
  );

  for (let col = 0; col < headerCells.length; col++) {
    const cell = (headerCells[col] || "").trim();
    if (!cell || profile.emptyCells.includes(cell)) continue;

    const gradePrices = gradePricesFor(col, grades, profile);
    // A column with no prices is a layout artifact, not a style -- usually.
    // Counted, because a book where EVERY column drops this way is a book
    // whose grade labels the profile no longer recognises.
    if (gradePrices.length === 0) {
      columnsDropped++;
      continue;
    }

    const skus = profile.expandSkus ? profile.expandSkus(cell, lines, col) : [cell];
    // The profile could not name this column's SKUs without guessing.
    if (skus.length === 0) {
      columnsUnplaceable++;
      continue;
    }
    const styleOptions = optionsFor(col, optionCells, profile);
    const dim = (key: string) => parseDimension(rows[key]?.[col] || "", profile.emptyCells);

    for (const styleNumber of skus) {
      products.push({
        styleNumber,
        styleName: (rows.name?.[col] || "").trim(),
        description: (rows.desc?.[col] || "").trim(),
        leatherStyleNumber: leatherByStyle.get(cell) ?? null,
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

  return { products, columnsDropped, columnsUnplaceable, rowsMisaligned };
}

/**
 * What the engine saw on the way to its products. Every count here exists so
 * that "zero styles" can be explained: a book with 40 pages, 0 kept and 40
 * dropped by `pageRequires` is a different failure from 40 pages, 40 kept,
 * 0 grids -- and both are different from 40 grids whose every column dropped.
 */
export interface WholesaleParseStats {
  /** Pages the renderer produced. */
  pagesSeen: number;
  /** Pages `pageRequires` rejected before any grid was looked for. */
  pagesDropped: number;
  /** Pages on which at least one grid header matched. */
  pagesWithGrids: number;
  /** Grid chunks parsed. */
  grids: number;
  /** Style columns that had a header cell but no recognised grade price. */
  columnsDropped: number;
  /** Positional rows left unset because their cell count was not the style count. */
  rowsMisaligned: number;
  /** Priced columns not imported because the profile could not name their SKUs. */
  columnsUnplaceable: number;
  /** Styles imported with no name or description: `layoutText` could not place their words. */
  layoutUnplaced: number;
}

/**
 * The engine's result: products, plus the diagnostics and counts that say why
 * there are as many as there are. `data.length === 0` is always accompanied by
 * at least one `error` diagnostic -- a parse that produced nothing has to say
 * so, because the route and the UI treat an error diagnostic as a refusal.
 */
export interface WholesaleParseResult extends ParseResult<ParsedWholesaleProduct> {
  stats: WholesaleParseStats;
}

/**
 * Fold one grid's losses into the book's counts, and say each one out loud: a
 * column or row the engine declined to read is a warning on its page, never a
 * silent gap.
 */
function reportGrid(
  parsed: ReturnType<typeof parseGrid>,
  pageNumber: number,
  stats: WholesaleParseStats,
  diagnostics: ParseDiagnostic[],
): void {
  const warn = (message: string) =>
    diagnostics.push({
      level: "warning",
      row: pageNumber,
      message: `page ${pageNumber}: ${message}`,
    });
  stats.columnsDropped += parsed.columnsDropped;
  stats.columnsUnplaceable += parsed.columnsUnplaceable;
  stats.rowsMisaligned += parsed.rowsMisaligned.length;
  if (parsed.columnsDropped > 0) {
    warn(`${parsed.columnsDropped} style column(s) had a header but no recognised grade price`);
  }
  if (parsed.columnsUnplaceable > 0) {
    warn(
      `${parsed.columnsUnplaceable} priced column(s) not imported -- their SKUs could not be determined without guessing`,
    );
  }
  if (parsed.rowsMisaligned.length > 0) {
    warn(
      `${parsed.rowsMisaligned.join(", ")} did not have one value per style (dropped or glued cells), so no value can be placed; left unset rather than guessed`,
    );
  }
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
): WholesaleParseResult {
  const products: ParsedWholesaleProduct[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const stats: WholesaleParseStats = {
    pagesSeen: 0,
    pagesDropped: 0,
    pagesWithGrids: 0,
    grids: 0,
    columnsDropped: 0,
    rowsMisaligned: 0,
    columnsUnplaceable: 0,
    layoutUnplaced: 0,
  };
  const segments = text.split(/<<PAGE:(\d+)>>\n/);

  for (let i = 1; i < segments.length; i += 2) {
    const pageNumber = Number.parseInt(segments[i], 10);
    const pageText = segments[i + 1] || "";
    stats.pagesSeen++;

    if (profile.pageRequires && !profile.pageRequires.every((re) => re.test(pageText))) {
      stats.pagesDropped++;
      continue;
    }
    const chunks = splitIntoGrids(pageText, profile.gridHeader);
    if (chunks.length > 0) stats.pagesWithGrids++;
    for (const chunk of chunks) {
      stats.grids++;
      const parsed = parseGrid(chunk, pageNumber, profile);
      products.push(...parsed.products);
      reportGrid(parsed, pageNumber, stats, diagnostics);
    }
  }

  if (products.length === 0) {
    diagnostics.push({
      level: "error",
      message: describeEmpty(stats, profile),
    });
  }

  return {
    data: products,
    diagnostics,
    summary: summarise(products.length, stats, diagnostics),
    stats,
  };
}

/** One sentence that says WHY the engine found nothing, from the counts. */
function describeEmpty(stats: WholesaleParseStats, profile: WholesaleVendorProfile): string {
  const header = String(profile.gridHeader);
  if (stats.pagesSeen === 0) {
    return "the PDF rendered to no pages -- not a text PDF, or not a PDF at all";
  }
  if (stats.pagesDropped === stats.pagesSeen) {
    return (
      `all ${stats.pagesSeen} pages were dropped by pageRequires -- ` +
      `none carried every required pattern; wrong book, or a new edition that moved the labels`
    );
  }
  if (stats.grids === 0) {
    return (
      `0 grids on ${stats.pagesSeen - stats.pagesDropped} page(s): no line matched the grid header ${header}; ` +
      `wrong book, or a new edition that relabelled the style row`
    );
  }
  return (
    `${stats.grids} grid(s) found but every style column dropped for lack of a recognised grade price ` +
    `(${stats.columnsDropped} columns); the grade labels no longer match gradeOfRow -- likely a new edition`
  );
}

function summarise(
  styles: number,
  stats: WholesaleParseStats,
  diagnostics: readonly ParseDiagnostic[],
): ParseResult<never>["summary"] {
  return {
    totalRowsProcessed: stats.pagesSeen,
    successCount: styles,
    skippedCount: stats.pagesDropped,
    warningCount: diagnostics.filter((d) => d.level === "warning").length,
    errorCount: diagnostics.filter((d) => d.level === "error").length,
  };
}

/**
 * Take every style's name and description from the profile's `layoutText` map
 * (see `WholesaleVendorProfile.layoutText`): the map is the only source, so a
 * style it does not cover gets neither, is counted, and is warned about once.
 * Pure and exported so tests drive it without a PDF.
 */
export function applyLayoutText(
  result: WholesaleParseResult,
  layout: ReadonlyMap<string, LayoutText>,
): WholesaleParseResult {
  let unplaced = 0;
  const data = result.data.map((product) => {
    const placed = layout.get(product.styleNumber);
    if (!placed) unplaced++;
    return {
      ...product,
      styleName: placed?.name ?? "",
      description: placed?.description ?? "",
    };
  });
  const diagnostics = [...result.diagnostics];
  if (unplaced > 0) {
    diagnostics.push({
      level: "warning",
      message:
        `${unplaced} of ${data.length} styles imported with no name or description: ` +
        `their column's words could not be placed by position`,
    });
  }
  const stats = { ...result.stats, layoutUnplaced: unplaced };
  return { data, diagnostics, stats, summary: summarise(data.length, stats, diagnostics) };
}

/** What `extractWholesaleGrid` learns about the PDF itself, for `assertEdition`. */
export interface PdfMeta {
  numpages: number;
  title?: string;
  producer?: string;
}

/**
 * Check a parse against the profile's `expect` block and push one `error`
 * diagnostic per violation. Pure and exported so the coverage script and the
 * tests can run it on a fixture without a PDF.
 *
 * Never throws: the route decides the status, and a coverage run wants every
 * violation listed, not the first one.
 */
export function assertEdition(
  result: WholesaleParseResult,
  profile: WholesaleVendorProfile,
  ctx: { text: string; meta?: PdfMeta },
): WholesaleParseResult {
  const expect: EditionExpectation | undefined = profile.expect;
  if (!expect) return result;
  const errors: ParseDiagnostic[] = [];

  if (expect.minStyles !== undefined && result.data.length < expect.minStyles) {
    errors.push({
      level: "error",
      message: `expected >= ${expect.minStyles} styles for ${profile.label}, got ${result.data.length}`,
    });
  }

  if (expect.grades) {
    const declared = profile.grades.map((g) => g.code);
    const seen = new Set<string>();
    for (const p of result.data) for (const gp of p.gradePrices) seen.add(gp.grade);
    const missing = declared.filter((g) => !seen.has(g));
    if (expect.grades === "all" && missing.length > 0) {
      errors.push({
        level: "error",
        message: `grade ladder mismatch: ${missing.length} of ${declared.length} declared grades priced nothing (${missing.join(", ")})`,
      });
    }
    if (expect.grades === "some" && missing.length === declared.length) {
      errors.push({
        level: "error",
        message: `grade ladder mismatch: none of the ${declared.length} declared grades priced anything`,
      });
    }
  }

  if (expect.pageCountRange && ctx.meta) {
    const [lo, hi] = expect.pageCountRange;
    if (ctx.meta.numpages < lo || ctx.meta.numpages > hi) {
      errors.push({
        level: "error",
        message: `page count ${ctx.meta.numpages} is outside the ${lo}-${hi} this profile was written against`,
      });
    }
  }

  if (expect.bookMarkers) {
    for (const re of expect.bookMarkers) {
      if (!re.test(ctx.text)) {
        errors.push({
          level: "error",
          message: `book marker ${String(re)} not found anywhere in the rendered text`,
        });
      }
    }
  }

  if (errors.length === 0) return result;
  const diagnostics = [...result.diagnostics, ...errors];
  return {
    ...result,
    diagnostics,
    summary: summarise(result.data.length, result.stats, diagnostics),
  };
}

/**
 * Render a price-book PDF through the column-aware renderer, parse it, and
 * check the edition. The pdf-parse result carries the page count and document
 * info; they were read once and thrown away before this, which is the same as
 * not having them.
 */
export async function extractWholesaleGrid(
  pdfBuffer: Buffer,
  profile: WholesaleVendorProfile,
): Promise<WholesaleParseResult> {
  // The renderer already prefixes each page with `\f<<PAGE:N>>\n` (pdfUtils.ts).
  // This used to prepend a second marker, so every page split into two
  // segments -- one holding only the formfeed -- and the engine saw 2x pages,
  // with the phantom half always failing `pageRequires`. Products were never
  // affected; the page counts that now explain a zero would have been.
  const data = await parsePdf(pdfBuffer, { pagerender: columnAwarePageRenderer });
  const meta: PdfMeta = {
    numpages: Number(data.numpages) || 0,
    title: data.info?.Title ? String(data.info.Title) : undefined,
    producer: data.info?.Producer ? String(data.info.Producer) : undefined,
  };
  let result = parseRenderedGrid(data.text, profile);
  // A second pass for positions: the rendered text above has already thrown
  // them away, and only a profile that reads words by position pays for it.
  if (profile.layoutText) {
    result = applyLayoutText(result, profile.layoutText(await readPdfTextItems(pdfBuffer)));
  }
  return assertEdition(result, profile, { text: data.text, meta });
}
