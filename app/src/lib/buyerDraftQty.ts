// /app/src/lib/buyerDraftQty.ts
//
// A draft item's qty on its way out of the database. The column is
// Decimal(12,3) because fabric is drafted by the yard -- until 2026-10-17 it
// was Int, and a typed 12.5 yards was stored as 1. JSON sends a Decimal as
// text, so every route that sends or prices a draft item converts here (the
// #29 bug shape: "12.5" + 1 is "12.51" on a screen).

import type { Prisma } from "@prisma/client";
import { toQty } from "./inventory/quantity";

type Qty = Prisma.Decimal | number;

/** A draft item on its way to a screen, its qty a number. */
export function draftItemForClient<T extends { qty: Qty }>(row: T) {
  return { ...row, qty: toQty(row.qty) };
}

/** What a set of draft items will spend: qty x cost summed, to the cent. */
export function draftSpend(items: { qty: Qty; cost: Prisma.Decimal | number }[]): number {
  const spent = items.reduce((acc, it) => acc + toQty(it.qty) * Number(it.cost), 0);
  return Math.round(spent * 100) / 100;
}
