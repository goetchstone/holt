// app/prisma/seed/demo/names.ts
//
// Fake-but-plausible name/address/vendor data pools. Everything here is
// invented -- no real people, no real vendors, no real addresses. Emails
// are all @example.com (RFC 2606 reserved for exactly this purpose).

import type { Rng } from "./rng";
import { pick, randInt } from "./rng";

export const FIRST_NAMES = [
  "Avery",
  "Priya",
  "Marcus",
  "Elena",
  "Noah",
  "Sofia",
  "Deshawn",
  "Ingrid",
  "Liam",
  "Talia",
  "Owen",
  "Renata",
  "Caleb",
  "Miriam",
  "Theo",
  "Ana",
  "Jasper",
  "Nadia",
  "Colin",
  "Yusuf",
  "Harper",
  "Beatrix",
  "Gabriel",
  "Wren",
  "Mateo",
  "Freya",
  "Quinn",
  "Simone",
  "Julian",
  "Odette",
  "Felix",
  "Rosalind",
  "Diego",
  "Camille",
  "Silas",
  "Petra",
  "Ezra",
  "Lucia",
  "Ronan",
  "Ingaborg",
  "Amara",
  "Dmitri",
  "Willa",
  "Bram",
  "Selah",
  "Tobias",
  "Marguerite",
  "Kai",
] as const;

export const LAST_NAMES = [
  "Whitfield",
  "Castellano",
  "Merriweather",
  "Okonkwo",
  "Larkspur",
  "Delacroix",
  "Novak",
  "Bergstrom",
  "Ashworth",
  "Pellegrini",
  "Vance",
  "Ohara",
  "Kowalski",
  "Fairweather",
  "Solano",
  "Marchetti",
  "Thackeray",
  "Renaud",
  "Bellweather",
  "Sokolov",
  "Ivory",
  "Danforth",
  "Aldrich",
  "Corwin",
  "Vasquez",
  "Lindqvist",
  "Hartley",
  "Beaumont",
  "Okafor",
  "Rutherford",
  "Sandoval",
  "Whitcombe",
  "Iversen",
  "Marchbanks",
  "Talbot",
  "Esposito",
  "Greenhalgh",
  "Duchamp",
] as const;

export function randomPersonName(rng: Rng): { firstName: string; lastName: string } {
  return { firstName: pick(rng, FIRST_NAMES), lastName: pick(rng, LAST_NAMES) };
}

export function slugifyForEmail(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

export function emailFor(rng: Rng, firstName: string, lastName: string): string {
  const disambiguator = randInt(rng, 1, 9999);
  return `${slugifyForEmail(firstName)}.${slugifyForEmail(lastName)}${disambiguator}@example.com`;
}

export function phoneNumber(rng: Rng): string {
  // 555 exchange -- reserved for fictional use, never a real subscriber.
  return `(${randInt(rng, 200, 989)}) 555-${String(randInt(rng, 0, 9999)).padStart(4, "0")}`;
}

const STREET_NAMES = [
  "Maple",
  "Birchwood",
  "Harborview",
  "Chestnut Ridge",
  "Milldam",
  "Foundry",
  "Quarry",
  "Wintergreen",
  "Cobblestone",
  "Fieldstone",
  "Saltmarsh",
  "Orchard",
  "Cedar Hollow",
  "Anchor",
  "Millpond",
  "Coppermine",
  "Larkspur",
  "Bramblewood",
] as const;
const STREET_SUFFIXES = ["St", "Ave", "Ln", "Rd", "Way", "Ter", "Dr"] as const;

export function streetAddress(rng: Rng): string {
  return `${randInt(rng, 12, 4899)} ${pick(rng, STREET_NAMES)} ${pick(rng, STREET_SUFFIXES)}`;
}

/** Synthetic town/state/zip triples -- plausible Great Lakes shape (the
 * seeded org is a single-state retailer, matching the tax district), but
 * every name here is invented. */
export const TOWNS: readonly { city: string; state: string; zip: string }[] = [
  { city: "Millbrook Falls", state: "MI", zip: "49316" },
  { city: "Wintergreen Harbor", state: "MI", zip: "49740" },
  { city: "Ashford Crossing", state: "MI", zip: "49015" },
  { city: "Quarryville", state: "MI", zip: "48867" },
  { city: "Juniper Cove", state: "MI", zip: "49460" },
  { city: "Cobble Hill", state: "MI", zip: "49120" },
  { city: "North Foundry", state: "MI", zip: "48843" },
  { city: "Birchwood Center", state: "MI", zip: "49601" },
  { city: "Fieldstone", state: "OH", zip: "44017" },
  { city: "Larkspur Landing", state: "IN", zip: "46360" },
  { city: "Copperfield", state: "WI", zip: "53140" },
] as const;

export function randomTown(rng: Rng) {
  return pick(rng, TOWNS);
}

/** Invented furniture-trade vendor names -- no real manufacturers. */
export const VENDOR_NAMES = [
  "Northshore Casegoods Co.",
  "Amberlin Upholstery Works",
  "Foundry Row Furniture",
  "Wickfield Home Collections",
  "Cobblestone Leather Guild",
  "Harborview Case & Frame",
  "Millpond Textile Mills",
  "Cedar Hollow Woodworks",
  "Larkspur Lighting Studio",
  "Bramblewood Outdoor Living",
  "Saltmarsh Metalcraft",
  "Quarry Hill Casegoods",
  "Fieldstone Mattress Co.",
  "Anchor & Ash Furniture",
  "Coppermine Rug Traders",
] as const;

/** A distinct pool for the GENERIC consignment vendor -- never a real
 * consignment dealer. Kept separate from VENDOR_NAMES / product numbers so
 * ConsignmentItem barcodes never collide with a configured vendor number
 * prefix (VendorNumberPrefix in schema.prisma). */
export const CONSIGNMENT_VENDOR_NAME = "Anatolia Rug Traders (Consignment)";
export const CONSIGNMENT_VENDOR_CODE = "ANRT-CNG";

export const STAFF_DISPLAY_NAMES = [
  "Jordan Ashcombe",
  "Priya Deshmukh",
  "Marcus Lindqvist",
  "Elena Beaumont",
  "Noah Castellano",
  "Sofia Marchetti",
  "Deshawn Okonkwo",
  "Ingrid Sokolov",
  "Liam Fairweather",
  "Talia Rutherford",
  "Owen Whitfield",
  "Renata Vasquez",
] as const;
