// /app/src/lib/pricing/wholesale/vendors/bradingtonYoung.ts
//
// Bradington-Young wholesale price books. Same layout again, leather only —
// six rungs, no fabric ladder.
//
// THE QUIRK this vendor adds: "/"-joined SKU families. One price column can
// cover several style lines that share a frame and a price, printed as an item
// cell like "770/771/772/773/774" with a per-column suffix row "-87". That is
// five real SKUs (770-87 ... 774-87), and each wants its own style downstream,
// so this profile expands the column. Columns holding a single style carry the
// whole SKU in the item cell and print no suffix row.

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
    { key: "name", match: /^STYLE NAME:/ },
    { key: "desc", match: /^DESCRIPTION:/ },
    { key: "width", match: /^OVERALL Width/ },
    { key: "depth", match: /^OVERALL Depth/ },
    { key: "height", match: /^OVERALL Height/ },
    { key: "seatDepth", match: /^SEAT Depth/ },
    { key: "seatHeight", match: /^SEAT Height/ },
    { key: "armHeight", match: /^ARM Height/ },
  ],

  expandSkus(itemCell, gridLines, column) {
    const parts = itemCell
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length <= 1) return [itemCell.trim()];

    // The suffix sits on the line after the item header, in this column.
    const headerIdx = gridLines.findIndex((l) => /ITEM NUMBER:\t/.test(l));
    const suffixLine = headerIdx >= 0 ? gridLines[headerIdx + 1] : undefined;
    const suffix = suffixLine ? (suffixLine.split("\t").slice(1)[column] || "").trim() : "";

    // A family with no suffix is still a family; emit the bare numbers rather
    // than dropping four of five SKUs.
    if (!/^-\S+$/.test(suffix)) return parts;
    return parts.map((p) => `${p}${suffix}`);
  },
};
