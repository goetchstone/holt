// /app/src/lib/importFormFields.ts
//
// Flatten the multipart fields an import route reads from formidable's
// `fields` (every value an array) to one string each.

import type { Fields } from "formidable";

/**
 * The first value of each named field, or "" when the field is absent.
 *
 * Only the names the route asks for are read. Field names are chosen by the
 * client, so copying every field into a plain object would let a field named
 * `constructor` or `hasOwnProperty` shadow the object's own members (CodeQL
 * js/remote-property-injection); an allowlist never writes a client-chosen key.
 */
export function pickFormFields<K extends string>(
  raw: Fields,
  names: readonly K[],
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const name of names) {
    const val = Object.hasOwn(raw, name) ? raw[name] : undefined;
    out[name] = Array.isArray(val) ? val[0] || "" : String(val || "");
  }
  return out;
}
