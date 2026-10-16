// /app/src/lib/purchasing/receiptStatus.ts
//
// A PO's status after a native receipt, from its lines' ordered and received
// quantities.
//
// A line ordered at zero is a cancelled line (rule 31) and is left out of both
// sides of the count (rule 39). The receive route counted it as fully received
// -- 0 >= 0 -- so a PO with nothing received at all could read RECEIVED_PARTIAL.
//
// What counts as "partial" is the native rule kept as it was: any quantity on
// any line. The POS import's runner requires a complete line instead; which
// one is right is an open owner decision, so they are not merged here.

import type { PurchaseOrderStatus } from "@prisma/client";

export interface ReceiptLine {
  ordered: number;
  received: number;
}

export function nativeReceiptStatus(
  lines: ReceiptLine[],
  current: PurchaseOrderStatus,
): PurchaseOrderStatus {
  const live = lines.filter((l) => l.ordered > 0);
  if (live.length === 0) return current;
  if (live.every((l) => l.received >= l.ordered)) return "RECEIVED_FULL";
  if (live.some((l) => l.received > 0)) return "RECEIVED_PARTIAL";
  return current;
}
