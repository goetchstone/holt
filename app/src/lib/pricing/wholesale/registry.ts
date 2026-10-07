// /app/src/lib/pricing/wholesale/registry.ts
//
// Every wholesale price book this build can read.
//
// Adding a vendor is a profile module plus a line here — not an edit to the
// import route. That is the whole point of the seam: the route asks the registry
// what it knows, so a new vendor cannot require touching code that already works
// for the others.
//
// Lookup FAILS CLOSED. An unknown id returns undefined and the caller refuses
// the upload, rather than falling back to a "probably close enough" reader.
// Guessing at a price book produces plausible numbers at the wrong tiers, which
// is worse than a rejection because nobody goes looking (CLAUDE.md rule 63).

import type { WholesaleVendorProfile } from "./profile";
import { bradingtonYoung } from "./vendors/bradingtonYoung";
import { hooker } from "./vendors/hooker";
import { samMoore } from "./vendors/samMoore";

export const WHOLESALE_VENDOR_PROFILES: readonly WholesaleVendorProfile[] = [
  bradingtonYoung,
  hooker,
  samMoore,
];

/**
 * The same vendor arrives spelled two ways: the upload form posts the id
 * ("sam-moore") while the database holds the name ("Sam Moore"). Fold both to
 * one key, because a near-miss here does not error -- it silently reports "no
 * profile" and drops the caller back onto the shape-guessing fallback, which is
 * the misclassification this registry exists to prevent.
 */
function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

const BY_KEY = new Map(WHOLESALE_VENDOR_PROFILES.map((p) => [normalizeKey(p.id), p]));

/** The profile for a vendor id or name, or undefined when this build cannot read it. */
export function wholesaleProfileFor(vendorIdOrName: string): WholesaleVendorProfile | undefined {
  return BY_KEY.get(normalizeKey(vendorIdOrName));
}

/** Ids this build can read, for the upload UI and for error messages. */
export function supportedWholesaleVendorIds(): string[] {
  return WHOLESALE_VENDOR_PROFILES.map((p) => p.id).sort();
}
