// /app/src/lib/buyerDraftValidation.ts
//
// Pure validation helpers for buyer-draft drop-target / assignment
// rules. Used by both the UI (pre-check before optimistic update) and
// the API (final guard before persisting). Same rule on both sides so
// the UX and the server agree.

/** Shape we need from an item to validate a drop target. */
export interface ItemForCompatibility {
  vendorId: number | null;
}

/** Shape we need from a PO to validate accepting an item. */
export interface PoForCompatibility {
  vendorId: number | null;
}

export interface CompatibilityCheck {
  ok: boolean;
  /** Human-readable reason when not ok. Empty string when ok. */
  reason: string;
}

/**
 * An item can be assigned to a PO only when the two share a vendor.
 *
 * Rule:
 *   - both `vendorId` non-null and equal → OK
 *   - both `vendorId` null → OK (degenerate case; neither side has a
 *     vendor yet, no conflict to police)
 *   - exactly one side null → OK (lenient — don't break workflows
 *     where the buyer is in the middle of filling in a vendor)
 *   - both non-null and different → BLOCK (the actual case the user
 *     was hitting: dragging an American Leather item into a
 *     Bradington Young PO)
 *
 * The lenient handling of null mirrors how the UI lets the buyer move
 * fast — strictness gets in the way mid-edit and the rule that
 * actually matters in practice is "cross-vendor mismatch."
 */
export function isCompatiblePoForItem(
  item: ItemForCompatibility,
  po: PoForCompatibility,
): CompatibilityCheck {
  if (item.vendorId !== null && po.vendorId !== null && item.vendorId !== po.vendorId) {
    return {
      ok: false,
      reason:
        `Cross-vendor drop blocked: item vendor (${item.vendorId}) ` +
        `doesn't match PO vendor (${po.vendorId}). Move the item to a PO ` +
        `for its own vendor, or unassign it first.`,
    };
  }
  return { ok: true, reason: "" };
}
