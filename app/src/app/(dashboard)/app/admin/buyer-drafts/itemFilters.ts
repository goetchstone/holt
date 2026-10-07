// /app/src/app/(dashboard)/app/admin/buyer-drafts/itemFilters.ts
//
// Pure item-filter predicates for the buyer-drafts workbench. Extracted so the
// useMemo callback in the view stays trivial and the branching logic is unit-
// testable without React. Behaviour is verbatim from the legacy page.

import type { DraftItem, IdOrAllOrUnassigned, Status } from "./types";

export interface ItemFilterInput {
  statusFilter: Status | "ALL";
  vendorFilter: number | "ALL";
  poFilter: IdOrAllOrUnassigned;
  buyFilter: IdOrAllOrUnassigned;
  poToBuy: ReadonlyMap<number, number | null>;
}

function matchesPoFilter(item: DraftItem, poFilter: IdOrAllOrUnassigned): boolean {
  if (poFilter === "ALL") return true;
  if (poFilter === "UNASSIGNED") return item.draftPoId === null;
  return item.draftPoId === poFilter;
}

function matchesBuyFilter(
  item: DraftItem,
  buyFilter: IdOrAllOrUnassigned,
  poToBuy: ReadonlyMap<number, number | null>,
): boolean {
  if (buyFilter === "ALL") return true;
  const itemBuyId = item.draftPoId === null ? null : (poToBuy.get(item.draftPoId) ?? null);
  if (buyFilter === "UNASSIGNED") return itemBuyId === null;
  return itemBuyId === buyFilter;
}

export function passesItemFilters(item: DraftItem, f: ItemFilterInput): boolean {
  if (f.statusFilter !== "ALL" && item.status !== f.statusFilter) return false;
  if (f.vendorFilter !== "ALL" && item.vendorId !== f.vendorFilter) return false;
  if (!matchesPoFilter(item, f.poFilter)) return false;
  if (!matchesBuyFilter(item, f.buyFilter, f.poToBuy)) return false;
  return true;
}
