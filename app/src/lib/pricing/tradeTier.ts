// /app/src/lib/pricing/tradeTier.ts
//
// What a trade customer is entitled to (GAP-06 part C, DECISIONS 61). A manager
// gives a customer a trade tier (TradeTier: "Designer, 20% off"); on each
// eligible line that customer is then entitled to the line's retail less the
// tier's percent, rounded to the cent. It is an entitlement a manager set, not
// a discount a cashier gives: the discount policy measures any further discount
// from the entitled price (lib/sales/discountApproval.ts), and the line still
// records its retail as listPrice, so receipts show the whole saving.
//
// The one home for that arithmetic: the register and New Quote price a line
// with it, and the server judges the sale with it. Pure and client-safe -- no
// Prisma here. Which products may take a tier at all (the vendor allows it, not
// made to order, not a protection plan) is decided on the server
// (lib/pricing/tradeEligibility.ts) and handed in as `vendorAllows`.
//
//   - No tier, an inactive tier, or a tier whose percent (to the hundredth)
//     isn't above 0 and at most 100: nothing. `isTradeAccount` alone grants nothing; the tier decides.
//   - A vendor that doesn't allow trade discounts: nothing.
//   - An item on sale: nothing, unless the store says a tier applies to a sale
//     price too (AppSettings.pricing.tradeDiscountOnSaleItems, off by default --
//     the strictest choice).
//   - Rounded to the cent, never by the store's retail rounding rule: this is a
//     discount on a price, not a new retail.

import { toCents } from "@/lib/pricing/rounding";

/** A tier as it is read: Prisma's Decimal arrives as a Decimal, a string, or a number. */
export interface TradeTierLike {
  id: number;
  name: string;
  discountPercent: number | string | { toString(): string };
  isActive: boolean;
}

/** A customer's tier as the screens get it: only an active one with a real percent. */
export interface CustomerTradeTier {
  id: number;
  name: string;
  discountPercent: number;
}

/** The store's say on tiers (AppSettings.pricing). */
export interface TradeSettings {
  /** Whether a tier applies to an item's sale price as well. Off by default. */
  tradeDiscountOnSaleItems: boolean;
}

/** Strictest: an item on sale isn't discounted again for a tier. */
export const DEFAULT_TRADE_DISCOUNT_ON_SALE_ITEMS = false;

export type TradeReason =
  | "ENTITLED"
  | "NO_TIER"
  | "TIER_INACTIVE"
  | "TIER_NO_DISCOUNT"
  | "VENDOR_OPTED_OUT"
  | "ON_SALE"
  | "NO_PRICE";

export const TRADE_REASON_LABELS: Record<TradeReason, string> = {
  ENTITLED: "Trade price",
  NO_TIER: "No trade tier",
  TIER_INACTIVE: "The customer's trade tier is turned off",
  TIER_NO_DISCOUNT: "The trade tier takes nothing off",
  VENDOR_OPTED_OUT: "This vendor's items don't take trade discounts",
  ON_SALE: "On sale: trade discounts don't apply to sale prices",
  NO_PRICE: "No price to discount",
};

export interface TradeEntitlement {
  /** The unit price the customer is entitled to: the retail itself when no tier applies. */
  price: number | null;
  /** The tier's percent when it applies, else null. */
  tierPercent: number | null;
  reason: TradeReason;
}

/**
 * A tier's percent when it can take something off (above 0, at most 100), else
 * null -- rounded to the hundredth, the scale a line records it at
 * (OrderLineItem.tradeDiscountPercent, Decimal(5,2)). The price a line sells
 * for and the percent it records must be the same number: a later edit or a
 * quote changing hands rebuilds the line's trade price from what it recorded
 * (discountApproval.ts existingLinePolicy), so a 33.333% tier priced at 33.333
 * and recorded as 33.33 would read as a price someone typed. A percent that
 * rounds to nothing takes nothing off.
 */
export function tradeTierPercent(
  tier: Pick<TradeTierLike, "discountPercent"> | null,
): number | null {
  if (!tier) return null;
  const raw = Number(tier.discountPercent.toString());
  if (!Number.isFinite(raw)) return null;
  const percent = Math.round(raw * 100) / 100;
  return percent > 0 && percent <= 100 ? percent : null;
}

/**
 * Why a value can't be a tier's percent, or null when it can: a number from 0
 * to 100, to the hundredth -- the scale a line records it at. The trade tiers
 * routes refuse anything else, so a tier never says one percent and prices at
 * another.
 */
export function tierPercentProblem(value: unknown): string | null {
  const percent = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (value === "" || !Number.isFinite(percent)) return "Discount percent must be a number";
  if (percent < 0 || percent > 100) return "Discount must be between 0 and 100";
  if (Math.abs(percent * 100 - Math.round(percent * 100)) > 1e-6) {
    return "Discount can have at most two decimal places";
  }
  return null;
}

/** The tier a customer's sales get: active, with a percent that takes something off. Else null. */
export function customerTradeTier(
  tier: TradeTierLike | null | undefined,
): CustomerTradeTier | null {
  if (!tier?.isActive) return null;
  const percent = tradeTierPercent(tier);
  return percent === null ? null : { id: tier.id, name: tier.name, discountPercent: percent };
}

/**
 * The unit price a line is entitled to under the customer's tier. `effectiveRetail`
 * is what the item sells for today -- its sale price while a sale is on -- and
 * `onSale` says whether that is a sale price.
 */
export function entitledUnitPrice(input: {
  effectiveRetail: number | null;
  onSale: boolean;
  tier: Pick<TradeTierLike, "discountPercent" | "isActive"> | null;
  vendorAllows: boolean;
  settings: TradeSettings;
}): TradeEntitlement {
  const { effectiveRetail, onSale, tier, vendorAllows, settings } = input;
  const none = (reason: TradeReason): TradeEntitlement => ({
    price: effectiveRetail,
    tierPercent: null,
    reason,
  });
  if (!tier) return none("NO_TIER");
  if (!tier.isActive) return none("TIER_INACTIVE");
  const percent = tradeTierPercent(tier);
  if (percent === null) return none("TIER_NO_DISCOUNT");
  if (effectiveRetail === null || !(effectiveRetail > 0)) return none("NO_PRICE");
  if (!vendorAllows) return none("VENDOR_OPTED_OUT");
  if (onSale && !settings.tradeDiscountOnSaleItems) return none("ON_SALE");
  return {
    price: toCents(effectiveRetail * (1 - percent / 100)) / 100,
    tierPercent: percent,
    reason: "ENTITLED",
  };
}

/** "Trade 20%": what a screen shows beside a tier-priced line. */
export function tradeLabel(percent: number): string {
  return `Trade ${Number(percent.toFixed(2))}%`;
}

/**
 * A line on the register's cart or a quote being written, as a tier prices it.
 * The screens keep the retail the line was listed at beside the price it sells
 * for, so a tier can come on and off without losing either.
 */
export interface TierPricedLine {
  /** The unit retail the line was listed at: its effective retail. */
  retail: number;
  /** Whether the product may take a tier at all (the product lookups' `tradeEligible`). */
  tradeEligible: boolean;
  /**
   * Whether `retail` is a sale price today: the product lookups' `onSale`
   * (lib/pricing/salePrice.ts). Missing reads as not on sale.
   */
  onSale?: boolean;
  /**
   * Whether the store lets a tier come off a sale price
   * (AppSettings.pricing.tradeDiscountOnSaleItems), as the product lookups
   * report it (lib/pricing/screenPricing.ts). Missing reads as off, the
   * strictest choice.
   */
  tradeDiscountOnSaleItems?: boolean;
  /** Someone typed this line's price: a tier never moves it again. */
  priceTyped: boolean;
  /** A line coming back: a tier never prices one. */
  isReturn?: boolean;
  /** The unit price the line sells for. */
  price: number;
  /** The tier's percent the price reflects, or null. Shown as "Trade 20%". */
  tradePercent: number | null;
}

/** What a product lookup (GET /api/products, find-by-identifier) says about a product's price. */
export interface TierLookupFields {
  onSale?: boolean;
  tradeEligible?: boolean;
  tradeDiscountOnSaleItems?: boolean;
}

/**
 * The tier fields of a new register or New Quote line, from the product lookup
 * it came from (lib/pricing/screenPricing.ts): listed at `retail` -- the price
 * the lookup says it sells for today, its sale price while a sale is on --
 * untyped, with no tier yet. Both screens build a line through this, then price
 * it with priceLineForTier, so they read the same fields the server judges by.
 */
export function tierFieldsFromLookup(
  product: TierLookupFields,
  retail: number,
): Pick<
  TierPricedLine,
  "retail" | "tradeEligible" | "onSale" | "tradeDiscountOnSaleItems" | "priceTyped" | "tradePercent"
> & { price: number } {
  return {
    price: retail,
    retail,
    tradeEligible: product.tradeEligible === true,
    onSale: product.onSale === true,
    tradeDiscountOnSaleItems: product.tradeDiscountOnSaleItems === true,
    priceTyped: false,
    tradePercent: null,
  };
}

/**
 * A line priced for the customer's tier, or for no tier (`tier` null): the
 * register and New Quote run every line through this when a product goes on and
 * whenever the customer changes, so removing the customer restores retail.
 * A line whose price someone typed keeps it; a return or an ineligible product
 * sells at its retail; a sale item takes the tier only when the store's
 * setting the line carries says so, and then off the sale price. The server
 * judges the price it is sent with the same arithmetic
 * (lib/sales/discountApproval.ts catalogLinePolicies), so the two agree.
 */
export function priceLineForTier<T extends TierPricedLine>(
  line: T,
  tier: CustomerTradeTier | null,
): T {
  const settings: TradeSettings = {
    tradeDiscountOnSaleItems: line.tradeDiscountOnSaleItems ?? DEFAULT_TRADE_DISCOUNT_ON_SALE_ITEMS,
  };
  if (line.priceTyped) return line;
  if (line.isReturn || !line.tradeEligible) {
    return { ...line, price: line.retail, tradePercent: null };
  }
  const entitled = entitledUnitPrice({
    effectiveRetail: line.retail,
    onSale: line.onSale === true,
    // A tier reaches the screens only when it is active (customerTradeTier).
    tier: tier ? { discountPercent: tier.discountPercent, isActive: true } : null,
    vendorAllows: true,
    settings,
  });
  return { ...line, price: entitled.price ?? line.retail, tradePercent: entitled.tierPercent };
}
