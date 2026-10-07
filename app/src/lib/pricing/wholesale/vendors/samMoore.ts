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

  // Headings the renderer glues onto the following row's label.
  gluedSectionHeaders: [
    "STANDARD TRIM & AVAILABLE OPTIONS",
    "DIMENSIONS / WEIGHTS",
    "SPECIFICATIONS",
    "FABRIC",
  ],

  // Row labels are quoted from the July-2026 book. Anchored with ^ on purpose:
  // "BIAS WELT" is a substring of "CONTRAST PILLOW BIAS WELT", and "CONTRAST
  // WELT" of "CONTRAST PILLOW WELT". An unanchored match would price a sofa's
  // welt from the pillow row -- the same substring trap as Bradington-Young's
  // NOVELTY / NOVELTY PREMIUM, and just as silent.
  //
  // "N/C" means included at no charge; the book's "--" means Not Available and
  // is handled by `emptyCells`, so a frame that cannot take an option simply
  // does not carry it.
  options: [
    {
      match: /^SM - Down Plush - Upcharge/i,
      groupName: "Cushion Upgrade",
      optionName: "SM Down Plush",
      sortOrder: 0,
    },
    {
      match: /^SM - Spring Down Luxe - Upcharge/i,
      groupName: "Cushion Upgrade",
      optionName: "SM Spring Down Luxe",
      sortOrder: 1,
    },
    {
      match: /^POWER MECHANISM UPCHARGE/i,
      groupName: "Mechanism",
      optionName: "Power Mechanism",
      sortOrder: 0,
    },
    {
      match: /^WELT ONLY\s*\(delete Nails\)/i,
      groupName: "Trim & Finishing",
      optionName: "Welt Only (delete nails)",
      sortOrder: 0,
    },
    {
      match: /^CARTON OPTION Up-charge/i,
      groupName: "Trim & Finishing",
      optionName: "Carton Packaging",
      sortOrder: 1,
    },
    {
      match: /^1\/2"\s*-\s*7\s*\(Include Alpha/i,
      groupName: "Nail Trim",
      optionName: 'Nail Trim 1/2"',
      sortOrder: 0,
    },
    {
      match: /^3\/4"\s*-\s*6\s*\(Include Alpha/i,
      groupName: "Nail Trim",
      optionName: 'Nail Trim 3/4"',
      sortOrder: 1,
    },
    {
      match: /^CONTRAST WELT\s+\(B - ZZ/i,
      groupName: "Contrast Options",
      optionName: "Contrast Welt",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 0,
    },
    {
      match: /^BIAS WELT\s+\(B - ZZ/i,
      groupName: "Contrast Options",
      optionName: "Contrast Bias Welt",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 1,
    },
    {
      match: /^CONTRAST INSIDE BACK\s+\(B - ZZ/i,
      groupName: "Contrast Options",
      optionName: "Contrast Inside Back",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 2,
    },
    {
      match: /^CONTRAST OUT ARM & BACK\s+\(B - ZZ/i,
      groupName: "Contrast Options",
      optionName: "Contrast Out Arm & Back",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 3,
    },
    {
      match: /^CONTRAST OUT ARM & BACK\s+\(Prem/i,
      groupName: "Contrast Options",
      optionName: "Contrast Out Arm & Back (Premium fabric)",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 4,
    },
    {
      match: /^CONTRAST SEAT CUSHION\s+\(B - ZZ/i,
      groupName: "Contrast Options",
      optionName: "Contrast Seat Cushion",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 5,
    },
    {
      match: /^CONTRAST TOP ARM or PANEL\s+\(B - ZZ/i,
      groupName: "Contrast Options",
      optionName: "Contrast Top Arm or Panel",
      requiresTextInput: true,
      textInputLabel: "Specify contrast fabric (grade B-ZZ)",
      sortOrder: 6,
    },
  ],

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
