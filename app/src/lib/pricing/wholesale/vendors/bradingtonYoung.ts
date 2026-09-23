// /app/src/lib/pricing/wholesale/vendors/bradingtonYoung.ts
//
// Bradington-Young wholesale price book, leather only — six rungs, no fabric
// ladder. Written against the JULY 2026 edition (107 pages, 833 styles).
//
// THE QUIRK this vendor adds: "/"-joined SKU families. One price column can
// cover several style lines that share a frame and a price, printed as an item
// cell like "770/771/772/773/774" with a suffix like "-87" on the next line.
// That is five real SKUs (770-87 ... 774-87), each its own style downstream.
//
// The suffix line carries NO label, and only FAMILY columns print a suffix:
// single-style columns carry their whole SKU in the item cell, and the renderer
// may glue a style name onto the same line ("WEST HAVEN\t-CO\t-OT"). So the
// suffixes are the line's `-XX` cells in order, one per family column in order.
// Until 2026-09-23 this read the line positionally after dropping its first
// cell as a label, which gave 487 of 598 family SKUs a neighbour's suffix or
// none. When the count does not match, or the family's number list wraps onto
// the next line, the column's SKUs cannot be known and nothing is imported for
// it (see expandSkus in profile.ts) — a wrong SKU orders the wrong product.
//
// NAMES AND DESCRIPTIONS are read by position (`layoutText` below), not from
// the rendered rows. The book prints no STYLE NAME row: a column's name is
// unlabelled text under its item number, and a family's names wrap over lines
// ("Alder/Birch/" + "Cedar"), one name per SKU in family order. The renderer
// merges the last of those lines into the DESCRIPTION row, so every style on
// such a page imported a name fragment as its description until 2026-09-23.

import type { PdfTextItem } from "../../pdfUtils";
import type { LayoutText, WholesaleVendorProfile } from "../profile";

/**
 * Row labels, longest first. "LEATHER - NOVELTY PREMIUM" starts with
 * "LEATHER - NOVELTY", so testing the short label first would classify every
 * premium row as plain novelty — a silent one-tier price error.
 */
const GRADE_ROWS: { label: string; code: string; displayName: string }[] = [
  { label: "LEATHER - NOVELTY PREMIUM", code: "NVPR", displayName: "Novelty Premium" },
  { label: "LEATHER - NOVELTY", code: "NV", displayName: "Novelty" },
  { label: "LEATHER - GRADE 1", code: "L1", displayName: "Leather 1" },
  { label: "LEATHER - GRADE 2", code: "L2", displayName: "Leather 2" },
  { label: "LEATHER - GRADE 3", code: "L3", displayName: "Leather 3" },
  { label: "LEATHER - GRADE 4", code: "L4", displayName: "Leather 4" },
];

/** Ladder order for output is book order, which is grade 1..4 then novelty. */
const LADDER = ["L1", "L2", "L3", "L4", "NV", "NVPR"];

export const bradingtonYoung: WholesaleVendorProfile = {
  id: "bradington-young",
  label: "Bradington-Young",
  // Match whether the store spells it "Bradington Young" or "Bradington-Young".
  nameMatch: "bradington",
  grades: LADDER.map((code) => {
    const row = GRADE_ROWS.find((r) => r.code === code)!;
    return { code, kind: "leather" as const, displayName: row.displayName };
  }),
  leatherPlacement: "none",
  gridHeader: /ITEM NUMBER:\t/,
  emptyCells: ["N/A", "--"],
  // Schematic pages carry an item header but no prices; requiring a grade row
  // as well keeps them out rather than emitting priceless styles.
  pageRequires: [/^ITEM NUMBER:\t/m, /LEATHER - GRADE 1/],

  gradeOfRow(label) {
    for (const row of GRADE_ROWS) {
      if (label.startsWith(row.label)) return row.code;
    }
    return null;
  },

  rows: [
    { key: "style", match: /ITEM NUMBER:/ },
    { key: "desc", match: /^DESCRIPTION:/ },
    // Width and height are self-labelled lines (`W  84"`), and depth rides in
    // the OVERALL DIMENSIONS row as `D  38"`. Sectionals print "DIMENSIONS PER
    // STYLE" there instead, which yields no number.
    { key: "width", match: /^W\s+(?=\d)/, inline: true },
    { key: "depth", match: /^OVERALL DIMENSIONS:/ },
    { key: "height", match: /^H\s+(?=\d)/, inline: true },
    { key: "seatDepth", match: /^SEAT DEPTH:/i },
    { key: "seatHeight", match: /^SEAT HEIGHT:/i },
    { key: "armHeight", match: /^ARM HEIGHT:/i },
  ],

  expandSkus(itemCell, gridLines, column) {
    const parts = itemCell
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length <= 1) return [itemCell.trim()];

    const headerIdx = gridLines.findIndex((l) => /ITEM NUMBER:\t/.test(l));
    const header = gridLines[headerIdx]
      .split("\t")
      .slice(1)
      .map((c) => c.trim());
    const familyColumns = header.flatMap((c, i) => (c.includes("/") ? [i] : []));
    const next = (gridLines[headerIdx + 1] ?? "").split("\t").map((c) => c.trim());

    // The family's number list continues on the next line: it is truncated here.
    if (next.some((c) => /^\d[\d/]*$/.test(c))) return [];

    const suffixes = next.filter((c) => /^-\S+$/.test(c));
    // A family the book prints without any suffix is still a family.
    if (suffixes.length === 0) return parts;
    // Suffixes present but not one per family column: cannot be placed.
    if (suffixes.length !== familyColumns.length) return [];
    const suffix = suffixes[familyColumns.indexOf(column)];
    return parts.map((p) => `${p}${suffix}`);
  },

  layoutText: readLayoutText,
};

// ─── Names and descriptions, by position ─────────────────────────────────────
//
// Under each grid's ITEM NUMBER row, a column reads top to bottom:
//   the family's suffix ("-OT"), if it is a family;
//   the name -- a family's names wrap while a line ends in "/";
//   the description, down to the row label after DESCRIPTION: (PROGRAM:).
// Words go to the column whose item cell they are centred under. A column whose
// words do not fit that shape is left out of the map; the engine then imports
// its styles with neither name nor description, and says so.

/** Runs this close in y are one visual line (the tab renderer's Y_MERGE). */
const SAME_LINE = 3;
/**
 * This edition's line pitch in points (6.24 pt type on 7.68 pt leading,
 * measured). Row labels are centred in their rows, so a description can sit a
 * full line above its DESCRIPTION: label; a name sits two or more lines above.
 */
const LINE_PITCH = 7.68;
/** This edition's distance between item columns, in points (65-67, measured). */
const COLUMN_PITCH = 66;

interface Line {
  y: number;
  text: string;
}

function readLayoutText(items: readonly PdfTextItem[]): Map<string, LayoutText> {
  const placed = new Map<string, LayoutText>();
  const conflicting = new Set<string>();
  const pages = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    if (!item.s.trim()) continue;
    pages.set(item.page, [...(pages.get(item.page) ?? []), item]);
  }
  for (const runs of pages.values()) {
    for (const label of runs.filter((r) => r.s.trim() === "ITEM NUMBER:")) {
      for (const [sku, text] of readGrid(runs, label)) {
        const seen = placed.get(sku);
        if (seen && (seen.name !== text.name || seen.description !== text.description)) {
          conflicting.add(sku);
        }
        placed.set(sku, text);
      }
    }
  }
  // Printed twice with different words: which one is right is a guess.
  for (const sku of conflicting) placed.delete(sku);
  return placed;
}

/** One grid: the SKUs its columns cover, each with the words under it. */
function readGrid(runs: readonly PdfTextItem[], label: PdfTextItem): Map<string, LayoutText> {
  const out = new Map<string, LayoutText>();
  const labelColumn = (r: PdfTextItem) => Math.abs(r.x - label.x) < SAME_LINE;
  const below = (y: number) => runs.filter((r) => labelColumn(r) && r.y < y - SAME_LINE);
  const nearest = (rs: PdfTextItem[]) => rs.sort((a, b) => b.y - a.y)[0];

  const description = nearest(below(label.y).filter((r) => r.s.trim() === "DESCRIPTION:"));
  if (!description) return out;
  // A DESCRIPTION: past the next grid's item row belongs to that grid, not this.
  const nextGrid = nearest(below(label.y).filter((r) => r.s.trim() === "ITEM NUMBER:"));
  if (nextGrid && nextGrid.y > description.y) return out;
  const nextRow = nearest(below(description.y));
  if (!nextRow) return out;

  const cells = runs
    .filter((r) => Math.abs(r.y - label.y) < SAME_LINE && r.x > label.x + label.w)
    .sort((a, b) => a.x - b.x);
  const band = runs.filter(
    (r) => r.y < label.y - SAME_LINE && r.y > nextRow.y + SAME_LINE && r.x > label.x + label.w,
  );
  const columns = assignToColumns(cells, band);

  cells.forEach((cell, i) => {
    const read = readColumn(cell.s.trim(), columns[i], description.y);
    read?.skus.forEach((sku, k) => out.set(sku, read.text[k]));
  });
  return out;
}

/** Each run goes to the column whose item cell it is centred under, or nowhere. */
function assignToColumns(cells: PdfTextItem[], band: PdfTextItem[]): PdfTextItem[][] {
  const centres = cells.map((c) => c.x + c.w / 2);
  const gaps = centres.slice(1).map((c, i) => c - centres[i]);
  // Half the way to the neighbouring column; a one-column grid still has a limit.
  const reach = Math.min(...gaps, COLUMN_PITCH) / 2;
  const columns: PdfTextItem[][] = cells.map(() => []);
  for (const run of band) {
    const centre = run.x + run.w / 2;
    let best = 0;
    for (let i = 1; i < centres.length; i++) {
      if (Math.abs(centres[i] - centre) < Math.abs(centres[best] - centre)) best = i;
    }
    if (Math.abs(centres[best] - centre) <= reach) columns[best].push(run);
  }
  return columns;
}

/** A column's runs as lines, top to bottom, each line's runs left to right. */
function toLines(runs: PdfTextItem[]): Line[] {
  const lines: { y: number; runs: PdfTextItem[] }[] = [];
  for (const run of [...runs].sort((a, b) => b.y - a.y)) {
    const line = lines.find((l) => Math.abs(l.y - run.y) < SAME_LINE);
    if (line) line.runs.push(run);
    else lines.push({ y: run.y, runs: [run] });
  }
  return lines.map((l) => ({
    y: l.y,
    text: l.runs
      .sort((a, b) => a.x - b.x)
      .map((r) => r.s)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

const joined = (lines: Line[]) =>
  lines
    .map((l) => l.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * One column's SKUs and the words for each, or null when its words do not fit
 * the shape -- the caller then leaves every SKU in it unplaced.
 */
function readColumn(
  cell: string,
  runs: PdfTextItem[],
  descriptionY: number,
): { skus: string[]; text: LayoutText[] } | null {
  // The family's number list wraps onto the next line: expandSkus refuses these.
  if (runs.some((r) => /^\d[\d/]*$/.test(r.s.trim()))) return null;
  const suffixes = runs.filter((r) => /^-\S+$/.test(r.s.trim()));
  if (suffixes.length > 1) return null;
  const lines = toLines(runs.filter((r) => !suffixes.includes(r)));

  const parts = cell
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const family = parts.length > 1;
  const skus = family ? parts.map((p) => `${p}${suffixes[0]?.s.trim() ?? ""}`) : [cell];

  const read = readNames(lines, family, descriptionY);
  if (!read) return null;
  // A family's names are one per SKU, in order; any other count is a guess.
  // That count is also what refuses a name broken mid-word ("MARLEIGH/MANNIN" +
  // "G/MALLORY"): the line without a trailing "/" ends the list one name short.
  // A break inside the LAST name would keep the count and go unseen -- every
  // family in the July 2026 edition ends on a whole name, then its description.
  if (family && read.count > 0 && read.names.length !== skus.length) return null;
  const description = joined(lines.slice(read.count));
  // Every style in this edition has a description. None means the one line
  // taken as a name may be the description itself.
  if (!description) return null;
  return {
    skus,
    text: skus.map((_, i) => ({ name: read.names[i] ?? "", description })),
  };
}

/**
 * How many of a column's top lines are its name, and the names in them (none
 * when the first line is not at name height); null when that cannot be told.
 */
function readNames(
  lines: Line[],
  family: boolean,
  descriptionY: number,
): { names: string[]; count: number } | null {
  // A name sits more than a line above the DESCRIPTION: label; within a line
  // of it, the words are description.
  const atNameHeight = (l?: Line) => !!l && l.y > descriptionY + 1.5 * LINE_PITCH;
  if (!atNameHeight(lines[0])) return { names: [], count: 0 };
  if (!family) {
    // A second line at name height could be the name wrapping: not guessed.
    return atNameHeight(lines[1]) ? null : { names: [lines[0].text], count: 1 };
  }
  // Names continue while a line ends in "/" -- even onto the DESCRIPTION line.
  let count = 1;
  while (count < lines.length && lines[count - 1].text.endsWith("/")) count++;
  const names = joined(lines.slice(0, count))
    .split("/")
    .map((n) => n.trim())
    .filter(Boolean);
  return { names, count };
}
