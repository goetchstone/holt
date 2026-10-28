// /app/src/lib/pos/cartPricing.ts
//
// The single implementation of "what does this cart cost". Pure and
// isomorphic: the POS renders from it, and the order-creation endpoint prices
// from it, so the screen and the database cannot disagree.
//
// They used to. The arithmetic lived only inside PosView.tsx, and the server
// independently computed `netPrice: unitPrice * quantity` with tax on that
// undiscounted figure. Neither knew about the other:
//
//   - The client charged `subtotal - orderDiscount`, with NO tax.
//   - The server stored full price + tax, applying NO discount (item-level
//     discounts were sent and ignored; `orderDiscount` was not even read).
//
// A $1,000 sale with $100 off at 6% tax charged the customer $900, recorded
// an order worth $1,060.00, and left $160.00 outstanding forever. The charge
// and the books were both wrong, in opposite directions.
//
// The rule this establishes: THE SERVER PRICES THE ORDER. The client may
// display a total, never decide one. `priceCart` is the only place the
// arithmetic exists.

export type DiscountType = "PERCENT" | "AMOUNT";

export interface CartDiscount {
  type: DiscountType;
  /** Percent (0-100) for PERCENT, currency amount for AMOUNT. */
  value: number;
  label?: string;
}

export interface PricedCartItemInput {
  /** Unit price before any discount. */
  unitPrice: number;
  quantity: number;
  /** Applied in order, each to the running unit price. */
  discounts?: CartDiscount[];
  /** A return line contributes negatively to every total. */
  isReturn?: boolean;
}

export interface PricedCartItem {
  /** Unit price after item-level discounts, before the order discount. */
  discountedUnitPrice: number;
  /** Line total after item discounts. Negative for a return. */
  lineSubtotal: number;
  /** This line's share of the order-level discount. Never negative. */
  orderDiscountShare: number;
  /**
   * The line total that goes in OrderLineItem.netPrice: after BOTH item and
   * order discounts. netPrice is the LINE total, never the unit price
   * (docs/domains/reporting.md invariant).
   */
  netPrice: number;
  /** Tax on netPrice — i.e. on what the customer actually pays. */
  vatAmount: number;
}

export interface PricedCart {
  items: PricedCartItem[];
  /** Sum of line subtotals, after item discounts, before the order discount. */
  subtotal: number;
  orderDiscountAmount: number;
  /** subtotal - orderDiscountAmount. */
  netSubtotal: number;
  taxAmount: number;
  /** What the customer owes: netSubtotal + taxAmount. */
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The unit price a catalog product goes onto a new POS or quote line at: its
 * retail price, or null when it has none.
 *
 * Never a price made up from cost. Both screens used to fall back to two and
 * a half times cost, one business's markup, so a store that had not priced a
 * product sold it at holt's number (CLAUDE.md rule 63: unconfigured fails
 * closed; `__tests__/noInventedMarkup.test.ts` keeps it out). The caller refuses the line with `noRetailPriceMessage`, as USE-04
 * already does for an unset vendor markup.
 *
 * Zero counts as no price: an import writes 0 where the source had none, and
 * a line the store meant to give away can still be discounted to zero.
 * Accepts the string a Prisma Decimal serializes to as well as a number.
 */
export function catalogRetailPrice(product: {
  baseRetail?: number | string | null;
}): number | null {
  const { baseRetail } = product;
  if (baseRetail == null || baseRetail === "") return null;
  const price = Number(baseRetail);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Why a product with no retail price cannot go onto a line, and what to set. */
export function noRetailPriceMessage(product: {
  name?: string | null;
  productNumber: string;
}): string {
  const label = product.name || product.productNumber;
  return `${label} has no retail price. Set one in Inventory → Products before selling it.`;
}

/**
 * Apply item-level discounts to a unit price, in order.
 *
 * Sequential rather than summed: two 10% discounts are 19%, not 20%. That is
 * how the POS has always behaved and how staff expect stacked discounts to
 * read on the receipt. Clamped at zero — a discount can make something free,
 * never negative, which would otherwise turn a discount into a refund.
 */
export function discountedUnitPrice(unitPrice: number, discounts: CartDiscount[] = []): number {
  let price = unitPrice;
  for (const d of discounts) {
    price = d.type === "PERCENT" ? price * (1 - d.value / 100) : price - d.value;
  }
  return price < 0 ? 0 : price;
}

/** Resolve an order-level discount against a subtotal. Never exceeds it. */
export function computeOrderDiscount(
  discount: CartDiscount | null | undefined,
  subtotal: number,
): number {
  if (!discount || subtotal <= 0) return 0;
  const raw = discount.type === "PERCENT" ? subtotal * (discount.value / 100) : discount.value;
  return round2(Math.min(Math.max(raw, 0), subtotal));
}

/**
 * Price a whole cart.
 *
 * `taxRate` is a fraction (0.06), resolved by the caller from the order's
 * tax district and the customer's exemption — this module decides arithmetic,
 * not policy. It may also be an array, one rate per input item, for a
 * district whose TaxRule rows band the rate by price (resolveTaxRate.ts's
 * `rateForLineAmount`) — a flat rate charges every line the same, so a
 * scalar stays the common case and is exactly backward compatible; an array
 * shorter than `items` falls back to 0 for the missing tail.
 *
 * Tax is charged on the DISCOUNTED amount. Taxing the pre-discount figure
 * overcharges the customer on every discounted sale and overstates the tax
 * liability owed to the state. That's also what "the line amount" means for
 * banded-rate lookups: callers resolving a per-line rate should band against
 * the post-discount netPrice, not the list price — see resolveTaxRate.ts.
 */
export function priceCart(
  items: PricedCartItemInput[],
  opts: { taxRate?: number | number[]; orderDiscount?: CartDiscount | null } = {},
): PricedCart {
  const taxRateOpt = opts.taxRate ?? 0;
  const rateForIndex = (index: number): number =>
    Array.isArray(taxRateOpt) ? (taxRateOpt[index] ?? 0) : taxRateOpt;

  const base = items.map((item) => {
    const unit = discountedUnitPrice(item.unitPrice, item.discounts);
    const magnitude = round2(unit * item.quantity);
    return {
      discountedUnitPrice: unit,
      lineSubtotal: item.isReturn ? -magnitude : magnitude,
    };
  });

  const subtotal = round2(base.reduce((sum, l) => sum + l.lineSubtotal, 0));
  const orderDiscountAmount = computeOrderDiscount(opts.orderDiscount, subtotal);

  // Spread the order discount across lines in proportion to their value, so
  // per-line tax reflects what was actually charged for that line. Only
  // positive lines absorb it: letting a return line take a share would hand
  // the customer discount on money being given back.
  const positiveTotal = base.reduce((sum, l) => sum + (l.lineSubtotal > 0 ? l.lineSubtotal : 0), 0);

  // Cumulative rounding: each line's share is the rounded discount owed on
  // everything up to and including it, minus what earlier lines already took.
  // The shares sum to the discount exactly (the last positive line's running
  // total IS positiveTotal), and because the running figure only grows, no
  // share is negative or larger than its line. Rounding each share on its own
  // and handing the last line the remainder broke both: four $0.01 lines with
  // $0.02 off gave shares [.01, .01, .01, -.01] (__tests__/fuzz/cartPricing.fuzz.test.ts).
  let runningTotal = 0;
  let allocated = 0;
  const shares = base.map((l) => {
    if (orderDiscountAmount <= 0 || positiveTotal <= 0 || l.lineSubtotal <= 0) return 0;
    runningTotal += l.lineSubtotal;
    const owedSoFar = round2((runningTotal / positiveTotal) * orderDiscountAmount);
    const share = round2(owedSoFar - allocated);
    allocated = owedSoFar;
    return share;
  });

  const priced: PricedCartItem[] = base.map((l, i) => {
    const netPrice = round2(l.lineSubtotal - shares[i]);
    return {
      discountedUnitPrice: l.discountedUnitPrice,
      lineSubtotal: l.lineSubtotal,
      orderDiscountShare: shares[i],
      netPrice,
      vatAmount: round2(netPrice * rateForIndex(i)),
    };
  });

  const netSubtotal = round2(subtotal - orderDiscountAmount);
  const taxAmount = round2(priced.reduce((sum, l) => sum + l.vatAmount, 0));

  return {
    items: priced,
    subtotal,
    orderDiscountAmount,
    netSubtotal,
    taxAmount,
    total: round2(netSubtotal + taxAmount),
  };
}
