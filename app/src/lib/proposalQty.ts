// /app/src/lib/proposalQty.ts
//
// A proposal line's quantity on its way out of the database. The column is
// Decimal(12,3) like the order line it becomes, because fabric is quoted by
// the yard -- until 2026-10-17 it was Int, and a line of 12.5 yards was
// stored and ordered as 12. JSON sends a Decimal as text, so every route that
// sends a proposal line converts here.

import type { Prisma } from "@prisma/client";
import { toQty } from "./inventory/quantity";

/** A proposal line on its way to a screen, its quantity a number. */
export function proposalLineForClient<T extends { quantity: Prisma.Decimal | number }>(row: T) {
  return { ...row, quantity: toQty(row.quantity) };
}
