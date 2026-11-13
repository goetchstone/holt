// /app/src/lib/sales/giftCardLineShared.ts
//
// A gift card sold or reloaded as a line on a sale (owner, 2026-11-11: "a line on a sale", and
// "it also must be paid in full"). The cart line the register sends and create-from-cart reads,
// in one file both import (rule 7), and the words both use. Client-safe: no Prisma, no server code.
//
// The line is the card's number and what goes on it. Nothing else is priced on it: it takes no
// discount, no tax and no quantity, because a $50 card sold for $45 would put $5 on the card that
// nobody paid for. The server decides whether it's a new card or a reload from the number, and
// issues it with the payment that pays the sale off (lib/sales/giftCardLines.ts).

/** The cart line's kind, beside create-from-cart's PRODUCT / CONFIGURED / CUSTOM. */
export const GIFT_CARD_LINE = "GIFT_CARD";

/** A gift card on the cart, as the register posts it to create-from-cart. */
export interface GiftCardCartLine {
  type: typeof GIFT_CARD_LINE;
  /** The card's number, as scanned: a card already in use is reloaded, any other is new. */
  giftCardNumber: string;
  /** What goes on the card, and what the customer pays for it. */
  amount: number;
}

/** True for a cart line that is a gift card. */
export function isGiftCardCartLine(item: unknown): item is GiftCardCartLine {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { type?: unknown }).type === GIFT_CARD_LINE
  );
}

/** The line's name on the order, the receipt and the order screen. */
export const GIFT_CARD_LINE_NAME = {
  NEW: "Gift card",
  RELOAD: "Gift card reload",
} as const;

/**
 * Why a card can't be sold onto or paid with, or null when it's open. VOIDED (from before Void
 * was removed) and REPLACED are closed; a card retired by moving its balance names the new one.
 */
export function closedCardMessage(card: {
  status: string;
  replacedById?: number | null;
}): string | null {
  if (card.status === "REPLACED") {
    return card.replacedById
      ? `This card's balance moved to card #${card.replacedById}. Use that card.`
      : "This card's balance moved to a new card. Use that card.";
  }
  if (card.status === "VOIDED") return "This gift card was voided, so it can't be used.";
  return null;
}
