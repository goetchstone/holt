// /app/src/lib/labels/receivedTagPrint.ts
//
// The Receive PO screen's print of a receipt's tags, all at once after saving
// (ReceivePOView.tsx), without the screen: each line's copies
// (receivedTagCopies), sent to POST /api/print-label/batch in requests the route
// takes, and what became of each line. Pure but for the `send` it is handed, so
// it is tested without a browser or a printer (rule 14). Client-safe: it imports
// nothing that reaches Prisma.

import { inBatches } from "@/lib/labels/batchPrintShared";
import { receivedTagCopies, receivedTagsShortNote } from "@/lib/labels/tagCopies";
import { getErrorMessage } from "@/lib/toastError";

/** A received line to tag: what the receipt's printItems carry, and what the receiver calls it. */
export interface ReceivedTagLine {
  productId: number;
  quantity: number;
  name: string;
}

/** What the batch route answered for one item. */
export interface TagPrintResult {
  success: boolean;
  error?: string;
}

/**
 * One request to the batch route, and what it did with the receipt's lines it
 * carried. Both `results` and `refused` are null for a request never sent,
 * because one before it was refused.
 */
export interface ReceivedTagBatch {
  /** The lines it carried, counted from 1 in the receipt's order. */
  first: number;
  last: number;
  /** The route's result for each of those lines, in order; null when it did not answer. */
  results: TagPrintResult[] | null;
  /** Why the route refused the request; null when it answered or was never asked. */
  refused: string | null;
}

/** Posts one batch request's items and resolves to the route's results, in order. */
export type SendTagBatch = (
  items: { productId: number; copies: number }[],
) => Promise<TagPrintResult[]>;

/**
 * Prints the receipt's tags through the batch route in requests of at most
 * PRINT_BATCH_MAX_ITEMS lines (inBatches), in the receipt's order, one at a
 * time. The route refuses a bigger request whole, so a screen that sent every
 * line in one printed none of a receipt of more than 50 tagged lines. A refused
 * request stops the run, as the Sales screen's "Print all" does: what printed
 * before it stays printed, and the requests after it are not sent.
 */
export async function printReceivedTags(
  lines: readonly ReceivedTagLine[],
  send: SendTagBatch,
): Promise<ReceivedTagBatch[]> {
  const batches: ReceivedTagBatch[] = [];
  let first = 1;
  let stopped = false;
  for (const batch of inBatches(lines)) {
    const range = { first, last: first + batch.length - 1 };
    first = range.last + 1;
    if (stopped) {
      batches.push({ ...range, results: null, refused: null });
      continue;
    }
    const items = batch.map((line) => ({
      productId: line.productId,
      copies: receivedTagCopies(line.quantity).copies,
    }));
    try {
      batches.push({ ...range, results: await send(items), refused: null });
    } catch (err) {
      stopped = true;
      batches.push({
        ...range,
        results: null,
        refused: getErrorMessage(err, "The tags did not print."),
      });
    }
  }
  return batches;
}

/** "Sofa", or "Sofa through Lamp": the receipt's lines a batch carried, by name. */
function linesNamed(lines: readonly ReceivedTagLine[], batch: ReceivedTagBatch): string {
  const first = lines[batch.first - 1]?.name;
  const last = lines[batch.last - 1]?.name;
  return batch.first === batch.last ? first : `${first} through ${last}`;
}

/**
 * What the receiver is told, batch by batch: each line whose tag failed, named;
 * a refused request, with the lines it carried and the route's reason; the lines
 * not sent after it. A receipt that took one request gets the route's refusal as
 * it is. And the note on the lines that printed with pieces left to tag.
 */
export function receivedTagsReport(
  lines: readonly ReceivedTagLine[],
  batches: readonly ReceivedTagBatch[],
): { errors: string[]; note: string | null } {
  const failed: string[] = [];
  const unprinted: string[] = [];
  const printed: ReceivedTagLine[] = [];
  for (const batch of batches) {
    if (batch.results) {
      lines.slice(batch.first - 1, batch.last).forEach((line, i) => {
        const result = batch.results?.[i];
        if (result?.success) printed.push(line);
        else failed.push(`${line.name}: ${result?.error ?? "Print failed"}`);
      });
    } else if (batch.refused !== null) {
      unprinted.push(
        batches.length === 1
          ? batch.refused
          : `The tags for ${linesNamed(lines, batch)} did not print: ${batch.refused}`,
      );
    } else {
      unprinted.push(`The tags for ${linesNamed(lines, batch)} were not sent.`);
    }
  }
  return {
    errors: [
      ...(failed.length > 0 ? [`Some tags failed: ${failed.join("; ")}`] : []),
      ...unprinted,
    ],
    note: receivedTagsShortNote(
      printed.map((line) => ({ name: line.name, ...receivedTagCopies(line.quantity) })),
    ),
  };
}
