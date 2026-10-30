// /app/src/lib/delivery/deliveryFeeShared.ts
//
// GAP-09: what a delivery zone charges. Shared by the register, which shows the
// fee before the sale, and the server (deliveryFee.ts), which writes it, so the
// two can never price it differently. Client-safe: no Prisma here.

/** Refused above this: a delivery fee, not a typo of the order's total. */
export const DELIVERY_FEE_MAX = 100_000;

export interface ZoneFees {
  baseFee: number;
  perPieceFee: number | null;
}

/** One line of a sale, as far as the truck is concerned. */
export interface PieceLine {
  quantity: number;
  /** A line of goods. A line with no product (labour, a fee) carries nothing. */
  goods: boolean;
  isReturn?: boolean;
  /** Leaving with the customer today, so never on the truck. */
  takeWith?: boolean;
}

/**
 * The pieces a delivery carries: each unit of goods going out on the truck.
 * Returns and take-with lines are not, and nor is a line of zero or less
 * (CLAUDE.md rule 31: a zero-quantity line is a cancelled one). A cut length
 * (a fractional quantity, such as yards of a roll) goes out as one piece.
 */
export function deliveryPieces(lines: readonly PieceLine[]): number {
  let pieces = 0;
  for (const line of lines) {
    if (!line.goods || line.isReturn || line.takeWith || !(line.quantity > 0)) continue;
    pieces += Number.isInteger(line.quantity) ? line.quantity : 1;
  }
  return pieces;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The zone's fee for this many pieces: its base fee plus its per-piece fee. */
export function zoneFee(zone: ZoneFees, pieces: number): number {
  return round2(zone.baseFee + (zone.perPieceFee ?? 0) * pieces);
}

/** Why an amount can't be a delivery fee, or null when it can. */
export function deliveryFeeProblem(amount: unknown): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "A delivery fee must be an amount.";
  }
  if (amount < 0) return "A delivery fee can't be negative.";
  if (amount > DELIVERY_FEE_MAX) {
    return `A delivery fee can't be more than ${DELIVERY_FEE_MAX.toLocaleString("en-US")}.`;
  }
  return null;
}

/** What the zone would charge an address: GET /api/sales/delivery-fee-quote. */
export interface DeliveryFeeQuote {
  /** The ZIP the zone was looked up by, or null when there is no address. */
  zip: string | null;
  /** The active zone that delivers to it, or null when none does. */
  zone: { id: number; name: string } | null;
  pieces: number;
  /** The zone's fee, or null when no zone delivers there. */
  amount: number | null;
}

/** The order's current fee and what its zone would charge now. */
export interface OrderDeliveryFee {
  current: { lineItemId: number; amount: number; taxAmount: number } | null;
  quote: DeliveryFeeQuote;
}
