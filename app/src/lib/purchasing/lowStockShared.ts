// /app/src/lib/purchasing/lowStockShared.ts
//
// GAP-14: what "low" means, and the store's alert settings as a screen and a
// route both read them. Client-safe (rule 7).

import { roundQty } from "@/lib/inventory/quantity";

export interface LowStockRow {
  reorderPointId: number;
  productId: number;
  productNumber: string;
  productName: string;
  vendorId: number | null;
  vendor: string | null;
  storeLocationId: number;
  store: string;
  /** Keep at least this many at this store. */
  minQuantity: number;
  /** The least to order at a time, or null. */
  orderQuantity: number | null;
  /** Stock that can be sold today (lib/inventory/allocation.ts freePositionWhere). */
  free: number;
  /** Still to come on POs sent for stock to this store. */
  onOrder: number;
  /** On draft POs for this store: not on its way yet, but already being ordered. */
  onDraft: number;
  shortBy: number;
  /** What to order now; 0 when drafts already cover it. */
  suggested: number;
}

/**
 * Below its level, how far, and what to order. Free stock and what's on sent POs
 * count toward the level. A draft doesn't, since nothing has been ordered, so
 * the product stays on the list until the PO goes. But a draft already covering
 * it isn't suggested a second time.
 */
export function shortfall(q: {
  minQuantity: number;
  orderQuantity: number | null;
  free: number;
  onOrder: number;
  onDraft: number;
}): { shortBy: number; suggested: number } | null {
  const shortBy = roundQty(q.minQuantity - (q.free + q.onOrder));
  if (shortBy <= 0) return null;
  const stillNeeded = roundQty(shortBy - q.onDraft);
  if (stillNeeded <= 0) return { shortBy, suggested: 0 };
  return { shortBy, suggested: Math.max(stillNeeded, q.orderQuantity ?? 0) };
}

const MAX_ALERT_ADDRESSES = 10;
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+$/;

/** The addresses in what was typed, or why they can't be used. */
export function readAlertEmails(raw: string): { emails: string[] } | { problem: string } {
  const emails = raw
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (emails.length > MAX_ALERT_ADDRESSES) {
    return { problem: `Send the list to at most ${MAX_ALERT_ADDRESSES} addresses.` };
  }
  const bad = emails.find((e) => !ADDRESS.test(e));
  if (bad) return { problem: `${bad} doesn't look like an email address.` };
  return { emails };
}
