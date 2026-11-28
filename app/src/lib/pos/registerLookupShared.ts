// /app/src/lib/pos/registerLookupShared.ts
//
// The register's lookup (RegisterLookup.tsx): finding a sale already written,
// and checking a gift card, without leaving the register. The cashier could do
// neither from it: a sale was found in the orders list and a card's balance
// only while paying with it. Owner, 2026-11-28: "I should also be able to look
// up sales from the pos", and gift cards with them.
//
// The parts the screen and its test share. Client-safe.

/** A sale as the orders list answers it (GET /api/sales/orders), as far as the lookup shows. */
export interface FoundSale {
  id: number;
  orderno: string;
  orderDate: string | null;
  status: string;
  customerName: string | null;
  totalAmount: number;
  /** What is still owed, from the server (computeBalance). */
  balanceDue: number;
}

/** A gift card as its lookup answers it (GET /api/gift-cards/lookup?barcode=). */
export interface FoundGiftCard {
  barcode: string;
  status: string;
  initialAmount: number;
  currentBalance: number;
}

/**
 * What the lookup is called. Sales are found in the orders list, which is gated
 * on "View orders"; someone who operates the register without it is offered the
 * gift card check alone, not a search that can only refuse them.
 */
export function lookupLabel(canFindSales: boolean): string {
  return canFindSales ? "Look up a sale or a gift card" : "Check a gift card";
}

/** The fewest characters worth searching sales for. */
export const SALE_SEARCH_MIN = 2;

/** True when a payment can be taken on this sale at the register. */
export function saleTakesPayment(sale: Pick<FoundSale, "status" | "balanceDue">): boolean {
  return sale.status !== "CANCELLED" && sale.balanceDue > 0;
}

/** What a sale's line in the results says about money. */
export function saleMoneyLine(
  sale: Pick<FoundSale, "status" | "balanceDue" | "totalAmount">,
  fmt: (n: number) => string,
): string {
  if (sale.status === "CANCELLED") return "Cancelled";
  // A return is a sale of its own with the amounts negative: it read
  // "Paid, -$9,113.29" beside the sale it took back.
  if (sale.status === "RETURNED") return `Return of ${fmt(Math.abs(sale.totalAmount))}`;
  // A quote is not owed until it is a sale; a payment on it makes it one.
  if (sale.status === "QUOTE") return `Quote for ${fmt(sale.totalAmount)}`;
  if (sale.balanceDue > 0) return `Owes ${fmt(sale.balanceDue)} of ${fmt(sale.totalAmount)}`;
  return `Paid, ${fmt(sale.totalAmount)}`;
}

/** What a gift card's result says. */
export function giftCardLine(card: FoundGiftCard, fmt: (n: number) => string): string {
  const state = card.status === "ACTIVE" ? "" : ` (${card.status.toLowerCase()})`;
  return `${card.barcode}: ${fmt(card.currentBalance)} left of ${fmt(card.initialAmount)}${state}`;
}
