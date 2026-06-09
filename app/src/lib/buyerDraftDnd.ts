// /app/src/lib/buyerDraftDnd.ts
//
// Pure helper for parsing buyer-drafts drag-and-drop intent. Lifted out of
// the page handler per CLAUDE.md rule 14 — the testable surface is the
// id-string parsing, not the React wrapper around it.

import type { DragEndEvent } from "@dnd-kit/core";

/**
 * Two valid drag transitions in the buyer-drafts workbench:
 *  - active.id "item-<n>" + over.id "po-<n>" | "po-unassigned"  → item moves to PO
 *  - active.id "po-<n>"   + over.id "buy-<n>" | "buy-unassigned" → PO moves to Buy
 *
 * Anything else (no over, malformed id, mismatched prefixes) → null.
 */
export type DragTarget =
  | { kind: "item-to-po"; itemId: number; nextPoId: number | null }
  | { kind: "po-to-buy"; poId: number; nextBuyId: number | null };

export function parseDragTarget(event: DragEndEvent): DragTarget | null {
  const overId = event.over?.id;
  const activeId = event.active?.id;
  if (overId === undefined || activeId === undefined) return null;

  return parseDragIds(String(activeId), String(overId));
}

/**
 * String-only variant for testability. The DnD event wraps these in
 * UniqueIdentifier (string|number); the page already normalizes via
 * `String(id)` before calling. Test fixtures call this directly.
 */
export function parseDragIds(activeStr: string, overStr: string): DragTarget | null {
  if (activeStr.startsWith("item-")) return parseItemToPo(activeStr, overStr);
  if (activeStr.startsWith("po-")) return parsePoToBuy(activeStr, overStr);
  return null;
}

function parseItemToPo(activeStr: string, overStr: string): DragTarget | null {
  const itemId = Number(activeStr.slice("item-".length));
  if (!Number.isInteger(itemId)) return null;
  const nextPoId = parsePrefixedId(overStr, "po-");
  if (nextPoId === undefined) return null;
  return { kind: "item-to-po", itemId, nextPoId };
}

function parsePoToBuy(activeStr: string, overStr: string): DragTarget | null {
  const poId = Number(activeStr.slice("po-".length));
  if (!Number.isInteger(poId)) return null;
  const nextBuyId = parsePrefixedId(overStr, "buy-");
  if (nextBuyId === undefined) return null;
  return { kind: "po-to-buy", poId, nextBuyId };
}

// Parses "<prefix><n>" → n, "<prefix>unassigned" → null, anything else → undefined.
// `undefined` distinguishes "wrong shape, reject the drag" from "valid unassigned drop."
function parsePrefixedId(overStr: string, prefix: string): number | null | undefined {
  if (overStr === `${prefix}unassigned`) return null;
  if (!overStr.startsWith(prefix)) return undefined;
  const n = Number(overStr.slice(prefix.length));
  return Number.isInteger(n) ? n : undefined;
}
