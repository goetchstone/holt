// /app/src/lib/buyerDraftAutoLink.ts
//
// Slice 5 — auto-link buyer draft items to real Products via barcode/UPC
// match. Runs as a post-import sweep at the end of `runStockByItemImport`.
//
// The buyer-drafts flow:
//   DRAFT (buyer is editing) → READY → EXPORTED (CSV downloaded for
//   the POS import) → FULFILLED (auto-linked here when the item comes
//   back through Stock-by-Item)
//
// This closes the loop. Once the POS has imported the buyer's draft and
// the resulting Product appears in the daily Stock-by-Item file with a
// matching UPC, the draft graduates to FULFILLED + stores the linked
// Product id on `BuyerDraftItem.fulfilledProductId`. Downstream reports
// (workbook, "what's still pending fulfillment") use that field.
//
// Pure helper — no I/O. The runner does the DB queries + writes.

export interface DraftCandidate {
  id: number;
  barcode: string;
  status: string;
  fulfilledProductId: number | null;
}

/**
 * Map of UPC string → productId. Built from the `Upc` table; the runner
 * queries `prisma.upc.findMany({ where: { upc: { in: candidateBarcodes } } })`
 * and reduces to this shape.
 */
export type UpcIndex = ReadonlyMap<string, number>;

export interface AutoLinkPlan {
  /** Drafts to update with their new fulfilledProductId. */
  links: { draftId: number; productId: number }[];
  /** Drafts skipped because no UPC match was found (informational). */
  unmatchedDraftIds: number[];
}

/**
 * Given EXPORTED drafts with barcodes and a UPC → productId index,
 * return the link assignments to apply. Idempotent — already-linked
 * drafts are excluded by the runner's WHERE clause, but we filter here
 * too in case the caller is sloppy.
 *
 * Rules:
 *   1. Skip drafts where `fulfilledProductId` is already set
 *   2. Skip drafts whose status isn't EXPORTED (waiting on the POS import)
 *   3. Skip drafts with no barcode
 *   4. Match by exact UPC equality (barcodes are alphanumeric IDs;
 *      case-insensitive matches would alias different barcodes)
 *   5. If no UPC match, the draft stays EXPORTED and shows up next run
 */
export function planAutoLinks(drafts: readonly DraftCandidate[], upcIndex: UpcIndex): AutoLinkPlan {
  const links: { draftId: number; productId: number }[] = [];
  const unmatched: number[] = [];

  for (const draft of drafts) {
    if (draft.fulfilledProductId !== null) continue;
    if (draft.status !== "EXPORTED") continue;
    if (!draft.barcode || draft.barcode.trim() === "") continue;

    const productId = upcIndex.get(draft.barcode);
    if (productId === undefined) {
      unmatched.push(draft.id);
      continue;
    }
    links.push({ draftId: draft.id, productId });
  }

  return { links, unmatchedDraftIds: unmatched };
}
