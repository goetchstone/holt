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
// NOT READ from this edition: style names. The book prints no STYLE NAME row;
// names are unlabelled text wrapped across lines, which the tab renderer cannot
// place (PLAN VAL-02b(b), after positioned text lands in VAL-06a).

import type { WholesaleVendorProfile } from "../profile";

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
};
