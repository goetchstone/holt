// /app/src/lib/tax/taxGroupInput.ts
//
// The tax group a category or product editor sends (GAP-04b). One reading for
// all three routes that take it, so "clear it" and "leave it alone" cannot
// drift apart between them:
//
//   undefined     not sent: leave the stored group as it is. A caller that
//                 does not know the field must not wipe it.
//   null or ""    clear it: the category's group applies again (a product),
//                 or the district's rules do (a category).
//   an id         must name a real TaxGroup -- a 400 that says so, not the
//                 foreign-key 500 the database would give.

import type { PrismaTx } from "@/lib/inventory/allocation";

export type TaxGroupInput = { value: number | null | undefined } | { error: string };

export async function readTaxGroupId(tx: PrismaTx, raw: unknown): Promise<TaxGroupInput> {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === "") return { value: null };
  const id = Number(raw);
  if (!Number.isInteger(id)) return { error: "Tax group must be a tax group id" };
  const group = await tx.taxGroup.findUnique({ where: { id }, select: { id: true } });
  return group ? { value: id } : { error: "Tax group not found" };
}
