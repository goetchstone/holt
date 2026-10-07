// /app/src/lib/buyerDraftAutoFulfillPo.ts
//
// Slice 6.10 (2026-05-14) — auto-flip BuyerDraftPurchaseOrder to
// FULFILLED when every drafted item on it has arrived in real life.
//
// User direction 2026-05-14: "Should the system mark the po fulfilled
// automatically once it is received?"
//
// What "received in real life" means here: the draft item's
// `fulfilledProductId` (set at draft-time via barcode-lookup, catalog
// picker, or slice 5 auto-link) appears on a real `PurchaseOrderItem`
// whose parent `PurchaseOrder.status = "RECEIVED_FULL"`. We don't
// require a persistent draft→real PO link — the productId join is the
// same signal slice 6.7 uses for the linked-POs panel, made permanent
// here by stamping `BuyerDraftPurchaseOrder.status = "FULFILLED"`.
//
// Pure helper — no I/O. Caller does the Prisma queries; helper
// decides which draft POs are now eligible.

export interface DraftPoForAutoFulfill {
  id: number;
  status: string;
  /** The draft items attached to this PO (only those with a link
   *  matter for fulfillment — un-linked drafts indicate items that
   *  haven't gone through the POS yet, so the PO can't be fully
   *  fulfilled). */
  items: ReadonlyArray<{
    fulfilledProductId: number | null;
  }>;
}

/** Set of `Product.id` values for which the empirical real-world
 *  receipt evidence is sufficient. The caller builds this from
 *  `PurchaseOrderItem WHERE PurchaseOrder.status IN ['RECEIVED_FULL',
 *  'RECEIVED_PARTIAL']` (partial too — a partial-received Product
 *  has arrived in our warehouse; we don't require the entire PON
 *  to be RECEIVED_FULL, just the line for THIS product). */
export type ReceivedProductIds = ReadonlySet<number>;

export interface AutoFulfillPlan {
  /** Draft PO ids that should flip to FULFILLED. */
  draftPoIdsToFulfill: number[];
  /** Draft PO ids that were skipped because at least one item is not
   *  yet fully received, or because they're already in a terminal
   *  status. Informational; the runner doesn't act on them. */
  draftPoIdsSkipped: number[];
}

/**
 * Decide which draft POs are eligible to flip to FULFILLED right now.
 *
 * Rules:
 *   1. PO must be in a non-terminal status (DRAFT, READY, or EXPORTED).
 *      FULFILLED is already done. CANCELLED is intentional skip.
 *   2. The PO must have at least one item with `fulfilledProductId`
 *      set. An empty PO or one with all-unlinked items can't be
 *      automatically declared fulfilled — there's nothing to verify
 *      against.
 *   3. Every linked product on the PO must appear in `receivedProductIds`.
 *      Un-linked items (fulfilledProductId = null) are tolerated —
 *      they represent items the buyer drafted but didn't entered into
 *      the POS yet. We don't punish a PO for those.
 *
 * Conservative on purpose: false negatives are fine (buyer can still
 * mark the PO FULFILLED manually). False positives would silently
 * flip status on a PO whose items haven't actually arrived, which
 * is harder to undo.
 */
export function planAutoFulfill(
  draftPos: readonly DraftPoForAutoFulfill[],
  receivedProductIds: ReceivedProductIds,
): AutoFulfillPlan {
  const draftPoIdsToFulfill: number[] = [];
  const draftPoIdsSkipped: number[] = [];

  for (const po of draftPos) {
    if (!isEligibleStatus(po.status)) {
      draftPoIdsSkipped.push(po.id);
      continue;
    }
    const linkedItems = po.items.filter((it) => it.fulfilledProductId !== null);
    if (linkedItems.length === 0) {
      // Empty PO or no linkage yet — can't auto-fulfill.
      draftPoIdsSkipped.push(po.id);
      continue;
    }
    const allReceived = linkedItems.every(
      (it) => it.fulfilledProductId !== null && receivedProductIds.has(it.fulfilledProductId),
    );
    if (allReceived) {
      draftPoIdsToFulfill.push(po.id);
    } else {
      draftPoIdsSkipped.push(po.id);
    }
  }

  return { draftPoIdsToFulfill, draftPoIdsSkipped };
}

function isEligibleStatus(status: string): boolean {
  // DRAFT / READY / EXPORTED can all flip forward. FULFILLED is
  // already done. CANCELLED is the buyer's explicit "skip me" signal
  // and we don't override.
  return status === "DRAFT" || status === "READY" || status === "EXPORTED";
}
