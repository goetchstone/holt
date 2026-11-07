// /app/src/lib/sales/salePosShared.ts
//
// What a sale's purchase order allows (DECISIONS 51). Owner, 2026-11-07: a special order
// generates a PO, and it can't be acknowledged if the sale is to be cancelled or changed.
// "If the po is acknowledged, then we still may be able to cancel the order or we may
// decide to keep the piece and sell it off the floor." Shared by the screens and server.

/**
 * OPEN: the vendor hasn't acknowledged it (DRAFT, or SUBMITTED), so the sale can change.
 * ACKNOWLEDGED: the vendor has, and goods may be coming, so someone has to decide.
 * HERE: everything has arrived, so it's the store's piece either way.
 * CLOSED: nothing more can happen on it.
 */
export type PoStanding = "OPEN" | "ACKNOWLEDGED" | "HERE" | "CLOSED";

export function poStanding(status: string): PoStanding {
  if (status === "DRAFT" || status === "SUBMITTED") return "OPEN";
  if (status === "CONFIRMED" || status === "RECEIVED_PARTIAL") return "ACKNOWLEDGED";
  if (status === "RECEIVED_FULL") return "HERE";
  return "CLOSED";
}

/** What was decided about an acknowledged PO. */
export const PO_DECISIONS = ["VENDOR_AGREED", "KEEP_THE_PIECE"] as const;
export type PoDecision = (typeof PO_DECISIONS)[number];

export function isPoDecision(value: unknown): value is PoDecision {
  return typeof value === "string" && (PO_DECISIONS as readonly string[]).includes(value);
}

/** Why a line on this PO can't have its quantity or product changed, or null. */
export function poLineChangeProblem(po: { poNumber: string; status: string }): string | null {
  const standing = poStanding(po.status);
  if (standing === "ACKNOWLEDGED" || standing === "HERE") {
    return `${po.poNumber} is acknowledged, so this line can't be changed. Cancel the line, and add what's wanted instead.`;
  }
  return null;
}
