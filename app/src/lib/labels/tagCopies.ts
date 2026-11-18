// /app/src/lib/labels/tagCopies.ts
//
// How many of one tag a single print may ask for, and the check for it. Pure, so
// the check is tested without a database; `validateTagCopies` in
// lib/labelPrinter.ts turns a problem into a LabelSetupError on every print path.

/** Largest number of one tag in a single print. */
export const MAX_TAG_COPIES = 10;

/** What is wrong with `copies`, or null when it is a whole number from 1 to the limit. */
export function tagCopiesProblem(copies: unknown): string | null {
  if (
    typeof copies !== "number" ||
    !Number.isInteger(copies) ||
    copies < 1 ||
    copies > MAX_TAG_COPIES
  ) {
    return `copies must be a whole number from 1 to ${MAX_TAG_COPIES}.`;
  }
  return null;
}
