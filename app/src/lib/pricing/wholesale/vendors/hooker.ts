// /app/src/lib/pricing/wholesale/vendors/hooker.ts
//
// Hooker Custom Upholstery wholesale price books. Same layout as Sam Moore, but
// this book carries TWO ladders on one style: a letter-coded fabric range and a
// true leather grid.
//
// That is why `leatherPlacement` exists. Leather here is a higher tier of the
// same frame, so both ladders belong to one style — as opposed to books that
// print leather as its own style keyed off the base number. It used to be a
// one-vendor allowlist in the import route.

import type { WholesaleVendorProfile } from "../profile";

const FABRIC = ["B", "C", "D", "E", "F", "G", "H", "I", "J"];
const LEATHER = ["L1", "L2", "L3", "L4", "NV", "NVPR"];

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
      displayName:
        code === "NV"
          ? "Novelty"
          : code === "NVPR"
            ? "Novelty Premium"
            : `Leather ${code.slice(1)}`,
    })),
  ],
  leatherPlacement: "combined",
  gridHeader: /STYLE NUMBER:\t/,
  emptyCells: ["--"],
  comGrade: "E",

  gradeOfRow(label) {
    // Fabric rows name the ladder explicitly ("Fabric - Grade E (COM)").
    const fabric = /^Fabric\s*-\s*Grade\s+([A-Z])\b/.exec(label);
    if (fabric && FABRIC.includes(fabric[1])) return fabric[1];
    const leather = /^Leather\s*-\s*(?:Grade\s*)?(L[1-4]|NVPR|NV)\b/.exec(label);
    if (leather && LEATHER.includes(leather[1])) return leather[1];
    return null;
  },

  rows: [
    { key: "style", match: /STYLE NUMBER:/ },
    { key: "name", match: /^STYLE NAME:/ },
    { key: "desc", match: /^STYLE DESCRIPTION:/ },
    { key: "yardage", match: /PLAIN COM FABRIC Required/, deep: true },
    { key: "width", match: /^OVERALL Width/ },
    { key: "depth", match: /^OVERALL Depth/ },
    { key: "height", match: /^OVERALL Height/ },
    { key: "seatDepth", match: /^SEAT Depth/ },
    { key: "seatHeight", match: /^SEAT Height/ },
    { key: "armHeight", match: /^ARM Height/ },
  ],
};
