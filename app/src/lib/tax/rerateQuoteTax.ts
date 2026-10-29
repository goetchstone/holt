// /app/src/lib/tax/rerateQuoteTax.ts
//
// GAP-04d: a quote whose customer changes is taxed as that customer's sale.
//
// The customer decides a sale's tax: their exemption, then their own district,
// before the store's (resolveTaxRate.ts). PUT /api/sales/orders/[id] could
// change a quote's customer and re-rate nothing, so an exempt customer attached
// to a walk-in quote was still charged tax, and a taxed one inherited a
// stranger's exemption. This re-resolves the district and the exemption and
// re-rates every live line exactly as the register prices a new sale
// (create-from-cart: rateForLineAmount on the line's netPrice under its
// product's tax group, vatAmount = round2(netPrice x rate), totalTax = the
// rounded sum). Its delivery fee line has no product and sells under the
// delivery tax group, as setDeliveryFee taxed it (lib/delivery/deliveryFee.ts).
//
// Only for an order no money has touched: the caller checks. Tax on a paid
// order is what the customer was charged, a recorded fact that a later change
// of customer does not rewrite -- the same rule a native return follows when
// it copies its sale's rates (lib/returns/bookReturn.ts).

import type { PrismaTx } from "@/lib/inventory/allocation";
import { deliveryFeeTaxGroup } from "@/lib/delivery/deliveryFee";
import {
  LINE_TAX_GROUP_SELECT,
  lineTaxGroupOf,
  rateForLineAmount,
  resolveTaxDistrict,
} from "@/lib/tax/resolveTaxRate";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function rerateQuoteTax(tx: PrismaTx, orderId: number): Promise<void> {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      orderno: true,
      customerId: true,
      storeLocationId: true,
      deliveryFeeLineItemId: true,
      // Cancelled lines are out of every sum (CLAUDE.md rule 33) and keep the
      // rate they had.
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: { id: true, netPrice: true, product: { select: LINE_TAX_GROUP_SELECT } },
      },
    },
  });

  const taxDistrict = await resolveTaxDistrict(tx, {
    customerId: order.customerId,
    storeLocationId: order.storeLocationId,
    contextLabel: `order ${order.orderno ?? orderId}`,
  });

  const deliveryGroup = await deliveryFeeTaxGroup(tx);
  let totalTax = 0;
  for (const line of order.lineItems) {
    const netPrice = Number(line.netPrice);
    const group =
      line.id === order.deliveryFeeLineItemId ? deliveryGroup : lineTaxGroupOf(line.product);
    const rate = rateForLineAmount(taxDistrict.rules, netPrice, group).rate;
    const vatAmount = round2(netPrice * rate);
    totalTax += vatAmount;
    await tx.orderLineItem.update({
      where: { id: line.id },
      data: { vatRate: rate, vatAmount },
    });
  }

  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      taxDistrictId: taxDistrict.taxDistrictId,
      taxExemptReasonId: taxDistrict.taxExemptReasonId,
      totalTax: round2(totalTax),
    },
  });
}
