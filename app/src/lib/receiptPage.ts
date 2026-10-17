// /app/src/lib/receiptPage.ts
//
// The printed page a thermal receipt asks for.
//
// The receipt used to ask for `size: 80mm auto`. That is not a valid value --
// `size` takes one or two lengths, or a keyword, never a length and `auto`
// together -- so the browser dropped the declaration and the global landscape
// Letter rule in globals.css won. "Save as PDF" from the receipt therefore
// produced an 11x8.5 page with a narrow strip of receipt on it.
//
// Two lengths are always valid: the roll's width, and exactly as much paper as
// the receipt is long. A thermal driver feeds the same length; a PDF is a
// receipt-shaped page instead of a letter with a receipt on it.

/** Receipt paper width. The canvas is drawn this wide at 203 DPI. */
export const RECEIPT_WIDTH_MM = 80;
/** Canvas pixels across that width: 80mm at 203 DPI. */
export const RECEIPT_WIDTH_PX = 640;

/** Height in millimetres of a receipt drawn `heightPx` tall, rounded up to the
 *  next tenth so the last line is never clipped onto a second page. */
export function receiptHeightMm(heightPx: number): number {
  const mm = (heightPx * RECEIPT_WIDTH_MM) / RECEIPT_WIDTH_PX;
  return Math.ceil(mm * 10) / 10;
}

/** The `@page` rule for a receipt drawn `heightPx` tall. */
export function receiptPageRule(heightPx: number): string {
  return `@page { margin: 0; size: ${RECEIPT_WIDTH_MM}mm ${receiptHeightMm(heightPx)}mm; }`;
}

/**
 * Break `text` into lines no wider than `maxWidth`, by words, measured with the
 * caller's own font (a canvas context's `measureText`). A single word wider than
 * the line is put on a line of its own rather than split. Used for the store's
 * receipt footer (AppSettings.receiptFooter), which is free text the store
 * writes and must never run off the paper.
 */
export function wrapText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}
