// /app/src/lib/pricing/parseBoundary.ts
//
// The shared parse boundary of the lib/pricing parsers (rule 42): the one set of
// number readers and the one line splitter they use. A run of digits long enough
// to overflow reads as Infinity, and `Math.abs(qty * price - total) > 0.01` is
// false for Infinity - Infinity (NaN), so a parser's line-math check would wave an
// infinite price through into a PO. No reader here returns a non-finite number.
// What a non-finite value becomes depends on what the field means:
//
// - An order parser reads it as 0 and keeps the line (parseMoney, finiteFloat,
//   finiteInt). A $0 line does not trip the parser's own line-math check
//   (0 x qty = 0), so what tells the user is `splitLines`, which puts a warning on
//   the order when a line holds a number of 300 or more digits (`hasOverlongNumber`,
//   which counts "9,999" as four digits because parseMoney drops the commas). A
//   parser that can name the cell it could not read leaves that line out instead,
//   with a warning naming it, and applies the same 300-digit rule to the cell
//   (Simblist CSV, the nuORDER printout).
// - A price book leaves the cell out, as it does "N/A": `finiteOrNull` gives null,
//   and `pricingUtils.parseCurrency` gives NaN, its "no price in this cell".
//
// A 308-digit number still reads as finite and overflows once doubled or added,
// so a total of read amounts goes through `finiteSum`. Pure.

/** `parseFloat` of `raw` with thousands commas removed; 0 unless finite. */
export function parseMoney(raw: string): number {
  return finiteFloat(raw.replaceAll(",", ""));
}

/**
 * `parseFloat` of an already-clean numeric token; null unless finite. For a field
 * where "not stated" is null, never 0.
 */
export function finiteOrNull(raw: string): number | null {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** `parseFloat` of an already-clean numeric token; 0 unless finite. */
export function finiteFloat(raw: string): number {
  return finiteOrNull(raw) ?? 0;
}

/** The sum of `values`, each finite; 0 when the sum itself overflows. */
export function finiteSum(values: readonly number[]): number {
  const total = values.reduce((sum, v) => sum + v, 0);
  return Number.isFinite(total) ? total : 0;
}

/**
 * The longest line a parser reads. A real order line is a few hundred characters;
 * the parsers' regexes backtrack quadratically on one 50,000-character line (about
 * 3 s on an authenticated upload), so a longer line is cut here, once, and every
 * regex sees a bounded string.
 */
export const MAX_LINE_LENGTH = 1000;

/** A digit run this long cannot be a real amount (a double tops out near 1.8e308). */
const OVERLONG_NUMBER = /\d{300}/;

/**
 * Whether `text` holds a number of 300 or more digits, which cannot be a real
 * amount. Thousands commas do not break the number: parseMoney drops them before
 * it reads, so "9,999,...,999.00" with 331 digits overflows to 0 like a 331-digit
 * run, and is reported the same way.
 */
export function hasOverlongNumber(text: string): boolean {
  return OVERLONG_NUMBER.test(text.replaceAll(",", ""));
}

/** Why a cell that `hasOverlongNumber` was not read, after what the cell is. */
export const OVERLONG_REASON = "has 300 or more digits, which cannot be a real amount";

/**
 * `text` split on newlines, each line cut to MAX_LINE_LENGTH. Anything this
 * changes or cannot read is reported on `warnings` (the order's own array), once
 * per kind, in words a store user can act on.
 */
export function splitLines(text: string, warnings: string[]): string[] {
  let cut = 0;
  let overlong = 0;
  const lines = text.split("\n").map((l) => {
    if (hasOverlongNumber(l)) overlong++;
    if (l.length <= MAX_LINE_LENGTH) return l;
    cut++;
    return l.slice(0, MAX_LINE_LENGTH);
  });
  if (cut > 0) {
    warnings.push(
      cut === 1
        ? `1 line is longer than ${MAX_LINE_LENGTH} characters and was cut off there, so a ` +
            "price at the end of it may be missing. Check the PDF against the items."
        : `${cut} lines are longer than ${MAX_LINE_LENGTH} characters and were cut off there, ` +
            "so a price at the end of one may be missing. Check the PDF against the items.",
    );
  }
  if (overlong > 0) {
    // "May": a run past 308 digits overflows and is read as 0 or left out, but a
    // 300-308 digit one still reads, as an absurd amount the items will show.
    warnings.push(
      `${overlong} line${overlong === 1 ? " has" : "s have"} a number of 300 or more digits, ` +
        "which cannot be a real amount, so it may have been read as 0 or left out. " +
        "Check the PDF against the items.",
    );
  }
  return lines;
}

/** `parseInt` (base 10) of `raw`; 0 unless finite (400 digits overflow to Infinity). */
export function finiteInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}
