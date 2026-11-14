// /app/src/lib/pricing/tradeEligibility.ts
//
// Which catalog products may take a customer's trade tier (GAP-06 part C,
// DECISIONS 61), and the customer's tier. The arithmetic is
// lib/pricing/tradeTier.ts; this is the part that needs the database, read by
// the discount policy (lib/sales/discountApproval.ts) and by the product
// lookups the register and New Quote price from, so the screen and the server
// agree on which lines a tier touches.
//
// A product takes a tier when:
//   - its vendor allows trade discounts (Vendor.allowTradeDiscount);
//   - it isn't made to order: a configured or custom line is priced by hand
//     (Product.madeToOrder, minted by create-from-cart);
//   - it isn't a protection plan: a store keeps its plans in the category its
//     protection-plan commission plan names (lib/protectionPlanCommission.ts).
// A gift card, a delivery fee or a return is never a catalog product line, so
// it never gets here; the writers leave those out.

import type { PrismaTx } from "@/lib/inventory/allocation";
import { customerTradeTier, type CustomerTradeTier } from "@/lib/pricing/tradeTier";

/** Whether each of these products may take a trade tier, by product id. */
export async function tradeEligibleProducts(
  db: PrismaTx,
  productIds: readonly number[],
): Promise<Map<number, boolean>> {
  const ids = [...new Set(productIds)];
  const eligible = new Map<number, boolean>();
  if (ids.length === 0) return eligible;
  const [products, planRules] = await Promise.all([
    db.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        madeToOrder: true,
        categoryId: true,
        vendor: { select: { allowTradeDiscount: true } },
      },
    }),
    db.commissionPlanRule.findMany({
      where: { plan: { kind: "PROTECTION_PLAN" }, categoryId: { not: null } },
      select: { categoryId: true },
    }),
  ]);
  const planCategories = new Set(planRules.map((r) => r.categoryId));
  for (const p of products) {
    eligible.set(
      p.id,
      !p.madeToOrder && p.vendor.allowTradeDiscount && !planCategories.has(p.categoryId),
    );
  }
  return eligible;
}

/** The tier a customer's sales get now: active, with a percent that takes something off. */
export async function loadCustomerTradeTier(
  db: PrismaTx,
  customerId: number | null | undefined,
): Promise<CustomerTradeTier | null> {
  if (customerId == null) return null;
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: {
      tradeTier: { select: { id: true, name: true, discountPercent: true, isActive: true } },
    },
  });
  return customerTradeTier(customer?.tradeTier);
}
