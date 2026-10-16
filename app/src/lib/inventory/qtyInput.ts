// /app/src/lib/inventory/qtyInput.ts
//
// Reading a quantity someone typed. Client-safe (no Prisma import), so screens
// and routes parse the same way. A quantity is fractional -- a roll of fabric
// is a length -- so it is never read with parseInt, which turned 12.5 yards
// into 12 on the new-transfer, receiving and new-return forms.

/** Places kept on a stock quantity; matches QTY_DP in quantity.ts. */
const DP = 3;

/** A positive quantity to three places, or null when the input is not one. */
export function parseQty(input: unknown): number | null {
  const n = typeof input === "number" ? input : Number(String(input ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n * 10 ** DP) / 10 ** DP;
  return rounded > 0 ? rounded : null;
}
