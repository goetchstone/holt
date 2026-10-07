// /app/src/lib/vendorPrefixService.ts
//
// Loads the configured vendor number prefixes and applies them.
//
// The pure rules live in lib/vendorNumbering.ts; this is the database half plus
// the module-level cache. Prefixes change about as often as a vendor is added,
// and they are consulted per line item during an import, so re-reading them per
// row would be thousands of queries for a table with a handful of rows.
//
// OPT-IN: a deployment with no VendorNumberPrefix rows has the feature off.
// Every function here answers false / null, and callers behave exactly as they
// did before any of this existed.

import { prisma } from "@/lib/prisma";
import {
  isVendorNumber,
  ruleForNumber,
  toBarcode,
  toVendorNumber,
  type VendorPrefixRule,
} from "@/lib/vendorNumbering";

let cachedRules: VendorPrefixRule[] | null = null;

/**
 * Test-only: drop the cache so the next call re-reads a truncated test database.
 * Called by resetTestDb(), the same shape as the adapter's auto-create caches.
 */
export function clearVendorPrefixCacheForTesting(): void {
  cachedRules = null;
}

export async function getVendorPrefixRules(): Promise<VendorPrefixRule[]> {
  if (cachedRules) return cachedRules;
  const rows = await prisma.vendorNumberPrefix.findMany({
    select: { vendorId: true, prefix: true, barcodePrefix: true },
  });
  cachedRules = rows;
  return cachedRules;
}

/** True when the number carries a configured vendor prefix. */
export async function isConfiguredVendorNumber(value: string | null | undefined): Promise<boolean> {
  return isVendorNumber(value, await getVendorPrefixRules());
}

/** The vendor whose prefix this number carries, or null. */
export async function vendorIdForNumber(value: string | null | undefined): Promise<number | null> {
  return ruleForNumber(value, await getVendorPrefixRules())?.vendorId ?? null;
}

/** The number as it appears on the physical tag. Unrecognised numbers pass through. */
export async function toVendorBarcode(value: string): Promise<string> {
  return toBarcode(value, await getVendorPrefixRules());
}

/** The vendor's own number with our prefix removed, or null. */
export async function toConfiguredVendorNumber(
  value: string | null | undefined,
): Promise<string | null> {
  return toVendorNumber(value, await getVendorPrefixRules());
}
