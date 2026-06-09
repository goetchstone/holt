// /app/src/lib/consignment.ts

import type { ConsignmentItemStatus } from "@prisma/client";

// the POS system stores Marjan rugs as "MAR-1827-124A"; ConsignmentItem.barcode uses "M1827-124A".
// Both formats need to be matched and normalised to the barcode form for DB lookups.
export function isMarjanRug(productNumber: string | null | undefined): boolean {
  if (!productNumber) return false;
  return /^MAR-\d/i.test(productNumber) || /^M\d/.test(productNumber);
}

export function toMarjanBarcode(productNumber: string): string {
  // "MAR-1827-124A" → "M1827-124A"
  return productNumber.startsWith("MAR-") ? "M" + productNumber.slice(4) : productNumber;
}

// external product numbers use the format "MAR-9381-25" where "9381-25" is the
// ConsignmentItem.customerNumber assigned by Marjan. This bridges the two systems.
// The barcode format "M9381-25" (from toMarjanBarcode) also maps to "9381-25".
export function toMarjanCustomerNumber(productNumber: string): string | null {
  if (!isMarjanRug(productNumber)) return null;
  if (productNumber.startsWith("MAR-")) return productNumber.slice(4);
  if (productNumber.startsWith("M")) return productNumber.slice(1);
  return null;
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
