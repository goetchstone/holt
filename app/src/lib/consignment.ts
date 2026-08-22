// /app/src/lib/consignment.ts

import type { ConsignmentItemStatus } from "@prisma/client";
import { toVendorNumber, type VendorPrefixRule } from "@/lib/vendorNumbering";

// Vendor number prefixes used to be hardcoded here -- isMarjanRug,
// toMarjanBarcode, toMarjanCustomerNumber -- encoding ONE consignment vendor's
// scheme ("MAR-1827-124A" on the POS, "M1827-124A" on the tag). A second vendor
// matched nothing, silently. They now live in lib/vendorNumbering.ts, driven by
// VendorNumberPrefix rows, and a deployment with no rows has the feature off.

/**
 * customerNumbers of consigned items whose returns in this import batch fully offset
 * their sales — a same-day sell+return "wash" that must revert the rug to
 * ON_FLOOR instead of leaving it SOLD (owed to the consignor).
 *
 * Two things this gets right:
 *
 * 1. **Match on the customerNumber**, the only identifier the two sides share:
 *    the sold side carries the PHYSICAL rug barcode (e.g. "M8994-22") while the
 *    returned side carries the product-number-derived barcode
 *    (`toBarcode("MAR-10684-26", rules)` = "M10684-26") — those never equal each
 *    other, so a barcode-vs-barcode comparison silently misses every Marjan
 *    same-day sell+return. Both, however, resolve to the same customerNumber.
 *
 * 2. **Net quantity, not mere presence.** A rug is washed only when its return
 *    lines are at least as many as its sale lines in the batch. A rug that sold
 *    MORE times than it was returned (a re-sale, or a base+rewrite chain that
 *    keeps two active sale lines against one accounting return) is net-SOLD and
 *    must stay SOLD — reverting it would erase a real sale and understate what's
 *    owed to the consignor.
 */
export function findWashedRugCustomerNumbers(
  soldRugMatches: readonly { customerNumber: string | null }[],
  returnedProductNumbers: readonly (string | null | undefined)[],
  prefixRules: readonly VendorPrefixRule[],
): Set<string> {
  const soldCounts = new Map<string, number>();
  for (const { customerNumber } of soldRugMatches) {
    if (customerNumber) soldCounts.set(customerNumber, (soldCounts.get(customerNumber) ?? 0) + 1);
  }
  const returnedCounts = new Map<string, number>();
  for (const pn of returnedProductNumbers) {
    const cn = pn ? toVendorNumber(pn, prefixRules) : null;
    if (cn) returnedCounts.set(cn, (returnedCounts.get(cn) ?? 0) + 1);
  }
  const washed = new Set<string>();
  for (const [customerNumber, sold] of soldCounts) {
    const returned = returnedCounts.get(customerNumber) ?? 0;
    if (returned >= sold) washed.add(customerNumber);
  }
  return washed;
}

export function calculateRugPricing(cost: number): {
  anchorPrice: number;
  retailPrice: number;
} {
  const anchorPrice = Math.round(cost * 7 * 100) / 100;
  const retailPrice = Math.round((anchorPrice / 2) * 100) / 100;
  return { anchorPrice, retailPrice };
}

const STATUS_PRIORITY: Record<string, ConsignmentItemStatus> = {
  paid: "PAID",
  sold: "SOLD",
  returned: "RETURNED_VENDOR",
  missing: "MISSING",
};

export function mapConsignmentStatusRow(row: Record<string, unknown>): ConsignmentItemStatus {
  const isPaid = Number(row.is_paid) === 1;
  const isSold = Number(row.is_sold) === 1;
  const isReturned = Number(row.is_returned) === 1;
  const isMissing = Number(row.is_Missing) === 1;

  if (isPaid) return STATUS_PRIORITY.paid;
  if (isSold) return STATUS_PRIORITY.sold;
  if (isReturned) return STATUS_PRIORITY.returned;
  if (isMissing) return STATUS_PRIORITY.missing;
  return "ON_FLOOR";
}

const VALID_TRANSITIONS: Record<ConsignmentItemStatus, ConsignmentItemStatus[]> = {
  ON_FLOOR: ["ON_APPROVAL", "SOLD", "RETURNED_VENDOR", "MISSING"],
  ON_APPROVAL: ["ON_FLOOR", "SOLD"],
  SOLD: ["PAID", "ON_FLOOR"],
  RETURNED_VENDOR: [],
  MISSING: ["ON_FLOOR"],
  PAID: ["ON_FLOOR"],
};

export function isValidConsignmentTransition(
  from: ConsignmentItemStatus,
  to: ConsignmentItemStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidConsignmentTransitions(
  from: ConsignmentItemStatus,
): ConsignmentItemStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}
