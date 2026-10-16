// /app/src/lib/purchasing/receiptConditions.ts
//
// The conditions a receiver can record for a PO line, and which of them keep
// the goods out of saleable stock. One list (rule 37): the Receive PO screen
// offers it and the receive route acts on it. Client-safe.

export const RECEIPT_CONDITIONS = ["OK", "Damaged", "Wrong Item", "Short"] as const;
export type ReceiptCondition = (typeof RECEIPT_CONDITIONS)[number];

/** Received into the store's quarantine place: owned, not for sale. */
export const QUARANTINED_CONDITIONS: readonly string[] = ["Damaged", "Wrong Item"];

export function isQuarantinedCondition(condition: string | null | undefined): boolean {
  return condition != null && QUARANTINED_CONDITIONS.includes(condition);
}
