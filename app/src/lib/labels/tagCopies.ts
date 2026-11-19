// /app/src/lib/labels/tagCopies.ts
//
// How many of one tag a single print may ask for, and the check for it. Pure, so
// the check is tested without a database; `validateTagCopies` in
// lib/labelPrinter.ts turns a problem into a LabelSetupError on every print path.

/** Largest number of one tag in a single print. */
export const MAX_TAG_COPIES = 10;

/** `copies` itself when it is a whole number from 1 to the limit, otherwise
 *  null. The upper-bound comparison sits on the value that is returned, so a
 *  static analyser (CodeQL js/resource-exhaustion, alert 65) sees the bound on
 *  the path into `zpl.repeat`; a check that only returned a message did not. */
export function boundedTagCopies(copies: unknown): number | null {
  if (typeof copies !== "number" || !Number.isInteger(copies)) return null;
  if (copies < 1 || copies > MAX_TAG_COPIES) return null;
  return copies;
}

/** What is wrong with `copies`, or null when it is a whole number from 1 to the limit. */
export function tagCopiesProblem(copies: unknown): string | null {
  return boundedTagCopies(copies) === null
    ? `copies must be a whole number from 1 to ${MAX_TAG_COPIES}.`
    : null;
}
