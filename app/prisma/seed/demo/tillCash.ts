// app/prisma/seed/demo/tillCash.ts
//
// Cash-drawer denomination breakdown for TillCount rows. Pure integer-cents
// arithmetic (never floats) so a breakdown always sums EXACTLY to the
// target amount -- no penny drift between TillCount rows and Till.actualCash
// / Till.openingCash.

export const TILL_OPENING_FLOAT = 200;

const DENOMINATIONS_CENTS: readonly [string, number][] = [
  ["$100 Bill", 10000],
  ["$50 Bill", 5000],
  ["$20 Bill", 2000],
  ["$10 Bill", 1000],
  ["$5 Bill", 500],
  ["$1 Bill", 100],
  ["Quarter", 25],
  ["Dime", 10],
  ["Nickel", 5],
  ["Penny", 1],
];

export interface CashBreakdownRow {
  denomination: string;
  quantity: number;
  amount: number;
}

/** Break a dollar amount into a greedy denomination count. Always exact —
 * pennies absorb any remainder. */
export function breakdownCash(amountDollars: number): CashBreakdownRow[] {
  let cents = Math.round(Math.max(0, amountDollars) * 100);
  const rows: CashBreakdownRow[] = [];
  for (const [label, value] of DENOMINATIONS_CENTS) {
    const qty = Math.floor(cents / value);
    if (qty > 0) {
      rows.push({ denomination: label, quantity: qty, amount: Math.round(qty * value) / 100 });
      cents -= qty * value;
    }
  }
  return rows;
}
