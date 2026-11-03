// /app/src/lib/sales/orderDisclaimersShared.ts
//
// GAP-07: the facts about an order's disclaimers that both the server
// (lib/sales/orderDisclaimers.ts) and the screens (Settings > Disclaimers, the
// order page) read, so the limits and the "can it change now" rule are one.

export const DISCLAIMER_NAME_MAX = 60;
export const DISCLAIMER_TEXT_MAX = 2000;

/** A disclaimer as an order carries it: its own copy of the text. */
export interface OrderDisclaimerRef {
  id: number;
  orderDisclaimerId: number | null;
  text: string;
}

/**
 * Why an order's disclaimers can't change now, or null when they can: only a
 * quote or an order. Handed over, they are what the customer took the goods
 * under; cancelled, the order is finished.
 */
export function disclaimerEditProblem(status: string): string | null {
  if (status === "QUOTE" || status === "ORDER") return null;
  if (status === "CANCELLED") return "This order is cancelled.";
  return "This order has been handed over: its disclaimers are what the customer took the goods under.";
}
