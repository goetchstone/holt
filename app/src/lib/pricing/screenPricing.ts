// /app/src/lib/pricing/screenPricing.ts
//
// What a product lookup tells the register and New Quote about a product's
// price, so the screen prices a line the way the server will judge it (rule
// 42). One home for GET /api/products and /api/products/find-by-identifier:
//
//   - its price today, sale or not (lib/pricing/salePrice.ts, DECISIONS 60):
//     baseRetail, regularRetail, onSale, saleEndsOn;
//   - whether a customer's trade tier may discount it at all
//     (lib/pricing/tradeEligibility.ts, DECISIONS 61): tradeEligible;
//   - whether the store lets a tier come off a sale price
//     (AppSettings.pricing.tradeDiscountOnSaleItems): tradeDiscountOnSaleItems.
//     A store setting, carried on each product so a line holds everything
//     lib/pricing/tradeTier.ts priceLineForTier needs, as tradeEligible is.
//
// The server's own judgment (lib/sales/discountApproval.ts catalogLinePolicies)
// reads the same three sources, so a screen and the server agree.

import type { Prisma } from "@prisma/client";
import type { PrismaTx } from "@/lib/inventory/allocation";
import { effectiveRetailFor, retailResponseFields } from "@/lib/pricing/salePrice";
import { loadTradeSettings, tradeEligibleProducts } from "@/lib/pricing/tradeEligibility";

type MoneyLike = Prisma.Decimal | number | string | null | undefined;

export interface ScreenPriceFields extends ReturnType<typeof retailResponseFields> {
  tradeEligible: boolean;
  tradeDiscountOnSaleItems: boolean;
}

/** Each product's price fields for the screens, by product id, on the store's day `today`. */
export async function screenPriceFields<T extends { id: number; baseRetail: MoneyLike }>(
  db: PrismaTx,
  products: readonly T[],
  today: string,
): Promise<Map<number, ScreenPriceFields>> {
  if (products.length === 0) return new Map();
  const [retail, eligible, settings] = await Promise.all([
    effectiveRetailFor(products, today, db),
    tradeEligibleProducts(
      db,
      products.map((p) => p.id),
    ),
    loadTradeSettings(db),
  ]);
  return new Map(
    products.map((p) => [
      p.id,
      {
        ...retailResponseFields(retail.get(p.id)!),
        tradeEligible: eligible.get(p.id) === true,
        tradeDiscountOnSaleItems: settings.tradeDiscountOnSaleItems,
      },
    ]),
  );
}
