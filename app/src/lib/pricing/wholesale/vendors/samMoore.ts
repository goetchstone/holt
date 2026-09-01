// /app/src/lib/pricing/wholesale/vendors/samMoore.ts
//
// Sam Moore wholesale price books. Column-transposed grid, one style per column.
//
// Thirteen FABRIC tiers, letter-coded, and no leather ladder at all. The letters
// are the thing to be careful about: an import that guesses material from the
// shape of a code reads a bare letter as leather, which would file this vendor's
// entire range as leather at the wrong tier. Hence `kind` on every rung.

import type { WholesaleVendorProfile } from "../profile";

/** In book order — the order here is the tier order downstream. */
const GRADES = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "Z", "ZZ", "Prem 1", "Prem 2"];

export const samMoore: WholesaleVendorProfile = {
  id: "sam-moore",
  label: "Sam Moore",
  grades: GRADES.map((code) => ({ code, kind: "fabric" as const })),
  leatherPlacement: "none",
  gridHeader: /STYLE NUMBER:\t/,
  emptyCells: ["--"],
  // The book prints "Grade: E and COM" — one rung, two names.
  comGrade: "E",

  gradeOfRow(label) {
    // Premium tiers are labelled differently from the letter ladder.
    const prem = /Premium:\s*(Prem [12])/.exec(label);
    if (prem) return prem[1];
    // The renderer glitches labels ("FABRICGrade:  I"), so match loosely and
    // validate against the declared ladder rather than trusting the capture.
    const grade = /Grade:\s*([A-Z]{1,2})\b/.exec(label);
    if (grade && GRADES.includes(grade[1])) return grade[1];
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
