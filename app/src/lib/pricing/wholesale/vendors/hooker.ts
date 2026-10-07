// /app/src/lib/pricing/wholesale/vendors/hooker.ts
//
// Hooker Custom Upholstery wholesale price book. Written against the APRIL 2026
// Stocking Dealer edition (45 pages, 19 grid pages, 94 styles). Hooker's
// casegoods price list is a different book -- a flat line list, not a grid --
// and is not read by this profile (VAL-07).
//
// The book carries TWO ladders on one style: a letter-coded fabric range and a
// true leather grid. That is why `leatherPlacement` exists. Leather here is a
// higher tier of the same frame, so both ladders belong to one style -- as
// opposed to books that print leather as its own style keyed off the base
// number.
//
// What this edition does that the engine had to learn:
//   - the style label is split across two lines: `STYLE` carries the style
//     numbers, and the next line, `NUMBER:`, the leather SKUs. That row is
//     sparse -- a SKU prints only for styles offered in leather -- so the engine
//     matches each SKU to its style by number (`1344-005-L` -> `1344-005`),
//     never by position;
//   - overall dimensions are self-labelled in every cell (`W  30 1/2"`), so
//     those rows are `inline`;
//   - `N/A` marks a grade a style is not offered in.
// The earlier edition used a single `STYLE NUMBER:` header and `OVERALL Width`
// rows; nothing of it survives in the April 2026 book.

import type { WholesaleVendorProfile } from "../profile";

const FABRIC = ["B", "C", "D", "E", "F", "G", "H", "I", "J"];
const LEATHER = ["L1", "L2", "L3", "L4", "NV", "NVPR"];
// Rungs whose name isn't "Leather <n>".
const LEATHER_NAMES: Record<string, string> = { NV: "Novelty", NVPR: "Novelty Premium" };

export const hooker: WholesaleVendorProfile = {
  id: "hooker",
  label: "Hooker Custom Upholstery",
  // DB vendor rows read "Hooker Furniture", not the book's title.
  nameMatch: "hooker",
  grades: [
    ...FABRIC.map((code) => ({ code, kind: "fabric" as const })),
    ...LEATHER.map((code) => ({
      code,
      kind: "leather" as const,
      displayName: LEATHER_NAMES[code] ?? `Leather ${code.slice(1)}`,
    })),
  ],
  leatherPlacement: "combined",
  // `STYLE` then a tab: `STYLE NAME:` shares the first word but not the tab.
  gridHeader: /^STYLE\t/,
  emptyCells: ["--", "N/A"],
  comGrade: "E",

  // Every grid in the April 2026 book prints all fifteen rungs, so a rung that
  // prices nothing means the labels moved.
  expect: { minStyles: 60, grades: "all", bookMarkers: [/Custom Upholstery/i] },

  gradeOfRow(label) {
    // Fabric rows name the ladder explicitly ("Fabric - Grade E (COM)").
    const fabric = /^Fabric\s*-\s*Grade\s+([A-Z])\b/.exec(label);
    if (fabric && FABRIC.includes(fabric[1])) return fabric[1];
    const leather = /^Leather\s*-\s*(?:Grade\s*)?(L[1-4]|NVPR|NV)\b/.exec(label);
    if (leather && LEATHER.includes(leather[1])) return leather[1];
    return null;
  },

  rows: [
    { key: "style", match: /^STYLE$/ },
    { key: "leatherStyleNumber", match: /^NUMBER:$/ },
    { key: "name", match: /^STYLE NAME:/ },
    { key: "desc", match: /^DESCRIPTION:/ },
    { key: "yardage", match: /^COM Requirements:/ },
    { key: "width", match: /^W\s+/, inline: true },
    { key: "depth", match: /^D\s+/, inline: true },
    { key: "height", match: /^H\s+/, inline: true },
    { key: "seatDepth", match: /^SEAT Depth/ },
    { key: "seatHeight", match: /^SEAT Height/ },
    { key: "armHeight", match: /^ARM Height/ },
  ],
};
