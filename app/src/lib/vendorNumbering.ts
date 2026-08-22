// /app/src/lib/vendorNumbering.ts
//
// Vendor number prefixes: reading a product or part number back to the vendor
// that issued it.
//
// WHY PREFIXES EXIST. Two vendors happily ship parts numbered "1827", so a bare
// vendor number is not unique in a catalog that buys from both. Prefixing it --
// "MAR-1827" -- makes it unique while keeping the vendor's own number readable
// inside. A physical tag often carries a shorter form ("M1827"), because the
// label is small.
//
// This replaced a hardcoded scheme in lib/consignment.ts that knew exactly one
// vendor's prefixes. A second vendor matched nothing and did so SILENTLY: no
// error, just numbers that never resolved.
//
// OPT-IN: with no VendorNumberPrefix rows the feature is simply off and every
// function here returns null / false. Nothing is inferred from a vendor's name
// or code.
//
// Pure, so it is testable without a database; loading lives in the caller.

/** One vendor's numbering, as configured. */
export interface VendorPrefixRule {
  vendorId: number;
  /** As it appears on product and part numbers, e.g. "MAR-". */
  prefix: string;
  /** As it appears on a physical tag when it differs, e.g. "M". */
  barcodePrefix?: string | null;
}

function matches(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * The rule whose prefix a number carries, or null.
 *
 * Longest prefix wins. "MA-" and "MAR-" can both be configured, and a number
 * starting "MAR-" belongs to the more specific one -- resolving it to "MA-"
 * because that row sorted first would file the item under the wrong vendor.
 */
export function ruleForNumber(
  value: string | null | undefined,
  rules: readonly VendorPrefixRule[],
): VendorPrefixRule | null {
  if (!value) return null;
  const candidates = rules.filter(
    (r) => matches(value, r.prefix) || (r.barcodePrefix && matches(value, r.barcodePrefix)),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => {
    const len = (x: VendorPrefixRule) =>
      Math.max(
        matches(value, x.prefix) ? x.prefix.length : 0,
        x.barcodePrefix && matches(value, x.barcodePrefix) ? x.barcodePrefix.length : 0,
      );
    return len(r) > len(best) ? r : best;
  });
}

/** True when the number carries a configured vendor prefix. */
export function isVendorNumber(
  value: string | null | undefined,
  rules: readonly VendorPrefixRule[],
): boolean {
  return ruleForNumber(value, rules) !== null;
}

/**
 * The number as it appears on the physical tag.
 *
 * "MAR-1827-124A" -> "M1827-124A" when the vendor configures a barcodePrefix,
 * and unchanged when it does not. A number that carries no configured prefix is
 * returned as-is rather than mangled.
 */
export function toBarcode(value: string, rules: readonly VendorPrefixRule[]): string {
  const rule = ruleForNumber(value, rules);
  if (!rule) return value;
  if (matches(value, rule.prefix)) {
    const bare = value.slice(rule.prefix.length);
    return `${rule.barcodePrefix ?? rule.prefix}${bare}`;
  }
  return value;
}

/**
 * The vendor's own number, with our prefix removed.
 *
 * "MAR-9381-25" -> "9381-25", and "M9381-25" -> "9381-25". This is the only
 * identifier the two sides share: a sold line carries the physical tag while a
 * returned line carries the product-number form, so comparing tag to tag misses
 * every match. Both reduce to the same vendor number.
 */
export function toVendorNumber(
  value: string | null | undefined,
  rules: readonly VendorPrefixRule[],
): string | null {
  const rule = ruleForNumber(value, rules);
  if (!rule || !value) return null;
  if (matches(value, rule.prefix)) return value.slice(rule.prefix.length) || null;
  if (rule.barcodePrefix && matches(value, rule.barcodePrefix)) {
    return value.slice(rule.barcodePrefix.length) || null;
  }
  return null;
}
