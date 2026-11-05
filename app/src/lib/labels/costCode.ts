// /app/src/lib/labels/costCode.ts
//
// Cost on a tag, in a code only the store can read (GAP-18). A store picks ten
// different letters (AppSettings.costCipherKey); the first stands for 1, the
// ninth for 9 and the tenth for 0. With "MARBLECOUT", a cost of $1,250 reads
// MALT. It's in whole dollars, which is how a code like this is read on the floor.
//
// With no key set, a tag's costCode is blank, never the real number: there's no
// safe code to invent for a store that hasn't chosen one (rule 63). A template
// can still print baseCost, which is the real number, so the template screen says
// which is which.
//
// Pure: the Settings screen and the server share it (rule 7).

export const CIPHER_KEY_LENGTH = 10;

/** Why this can't be a store's key, or null. */
export function cipherKeyProblem(key: string): string | null {
  if (!/^[A-Z]+$/.test(key) || key.length !== CIPHER_KEY_LENGTH) {
    return `The cost code needs exactly ${CIPHER_KEY_LENGTH} letters, A to Z.`;
  }
  if (new Set(key).size !== CIPHER_KEY_LENGTH) {
    return "Each letter in the cost code can only be used once, or two digits would read the same.";
  }
  return null;
}

/** A key as a store typed it: capitals, with no spaces around it. */
export function normalizeCipherKey(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The cost in the store's code; blank with no key or no cost. */
export function costCode(cost: number | null | undefined, key: string | null | undefined): string {
  if (!key || cost == null || cost < 0) return "";
  return String(Math.round(cost))
    .split("")
    .map((digit) => key[(Number(digit) + 9) % 10])
    .join("");
}
