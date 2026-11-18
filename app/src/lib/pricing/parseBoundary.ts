// /app/src/lib/pricing/parseBoundary.ts
//
// The shared parse boundary of the vendor order parsers (rule 42): the one number
// reader and the one line splitter they use. A run of digits long enough to
// overflow reads as Infinity, and `Math.abs(qty * price - total) > 0.01` is false
// for Infinity - Infinity (NaN), so a parser's line-math check would wave an
// infinite price through into a PO. A non-finite reading is 0 here, and the line
// is accepted as it reads: a $0 line does not trip the parsers' own line-math
// check (0 x qty = 0). What tells the user is `splitLines`, which puts a warning
// on the order when a line holds a run of 300 or more digits. Pure.

/** `parseFloat` of `raw` with thousands commas removed; 0 unless finite. */
export function parseMoney(raw: string): number {
  return finiteFloat(raw.replaceAll(",", ""));
}

/** `parseFloat` of an already-clean numeric token; 0 unless finite. */
export function finiteFloat(raw: string): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The longest line a parser reads. A real order line is a few hundred characters;
 * the parsers' regexes backtrack quadratically on one 50,000-character line (about
 * 3 s on an authenticated upload), so a longer line is cut here, once, and every
 * regex sees a bounded string.
 */
export const MAX_LINE_LENGTH = 1000;

/** A digit run this long overflows to Infinity (a double tops out near 1e308). */
const OVERLONG_NUMBER = /\d{300}/;

/**
 * `text` split on newlines, each line cut to MAX_LINE_LENGTH. Anything this
 * changes or cannot read is reported on `warnings` (the order's own array), once
 * per kind, in words a store user can act on.
 */
export function splitLines(text: string, warnings: string[]): string[] {
  let cut = 0;
  let overlong = 0;
  const lines = text.split("\n").map((l) => {
    if (OVERLONG_NUMBER.test(l)) overlong++;
    if (l.length <= MAX_LINE_LENGTH) return l;
    cut++;
    return l.slice(0, MAX_LINE_LENGTH);
  });
  if (cut > 0) {
    warnings.push(
      `${cut} line${cut === 1 ? " is" : "s are"} longer than ${MAX_LINE_LENGTH} characters and ` +
        "was cut off there, so a price at the end of it may be missing. Check the PDF against the items.",
    );
  }
  if (overlong > 0) {
    warnings.push(
      `${overlong} line${overlong === 1 ? " has" : "s have"} a number of 300 or more digits, ` +
        "which was read as 0. Check the PDF against the items.",
    );
  }
  return lines;
}

/** `parseInt` (base 10) of `raw`; 0 unless finite (400 digits overflow to Infinity). */
export function finiteInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}
