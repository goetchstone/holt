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

/**
 * The tags receiving prints for a quantity received.
 *
 * A fractional quantity can only be a length: a part roll of fabric or wallpaper
 * arrives as 12.5 yards, and the receive flow keeps it as that length, never
 * truncated (lib/inventory/qtyInput.ts). It is one item, so it gets one tag and
 * leaves none to print. A whole number is a count of pieces: one tag each, at most
 * MAX_TAG_COPIES, and `untagged` is the pieces that leaves without one. Nothing
 * records a unit, so a whole-number length (a 30-yard bolt) reads as 30 pieces:
 * an owner question (printing.md).
 *
 * At most MAX_TAG_COPIES, as the batch print clamped them before #127: since then
 * it refuses more, and the Receive PO screen, which asked for the quantity itself,
 * printed none of a line of more than ten or of a part roll. The bound itself is
 * unchanged: every other caller asking for more is still refused.
 */
export function receivedTagCopies(quantity: number): { copies: number; untagged: number } {
  if (!Number.isInteger(quantity)) return { copies: 1, untagged: 0 };
  const pieces = Math.max(1, quantity);
  const copies = Math.min(pieces, MAX_TAG_COPIES);
  return { copies, untagged: pieces - copies };
}

/**
 * What receiving tells the receiver about lines left with pieces to tag, or null.
 * Only a count of more than MAX_TAG_COPIES pieces leaves any: a length has its one.
 */
export function receivedTagsShortNote(
  lines: readonly { name: string; copies: number; untagged: number }[],
): string | null {
  const short = lines.filter((line) => line.untagged > 0);
  if (short.length === 0) return null;
  const each = short.map(
    (line) => `${line.name}: ${line.copies} tags printed, ${line.untagged} still to print`,
  );
  return (
    `${each.join("; ")}. A print takes at most ${MAX_TAG_COPIES} of one tag, ` +
    "so print the rest from the product's page."
  );
}
