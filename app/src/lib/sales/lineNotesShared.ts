// /app/src/lib/sales/lineNotesShared.ts
//
// GAP-07: a note on an order line -- "legs in walnut", "customer to confirm
// fabric". Printed under the line on the invoice, and found by the orders
// search (api/sales/orders/index.ts). One reader for the line-edit route and
// the order page's limit, so the two agree on what a note may be.

export const LINE_NOTE_MAX = 500;

/**
 * A note as stored: trimmed, and null when empty, so clearing a note leaves no
 * blank string for the search to match. A problem is a message for the caller.
 */
export function readLineNote(raw: unknown): { note: string | null } | { problem: string } {
  if (raw === null) return { note: null };
  if (typeof raw !== "string") return { problem: "A line note must be text, or null." };
  const note = raw.trim();
  if (note.length > LINE_NOTE_MAX) {
    return { problem: `Keep a line note under ${LINE_NOTE_MAX} characters.` };
  }
  return { note: note || null };
}
