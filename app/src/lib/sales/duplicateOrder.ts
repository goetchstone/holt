// /app/src/lib/sales/duplicateOrder.ts
//
// GAP-07: duplicate an order -- the same goods again, for the same customer or
// as the start of someone else's quote. The copy is a new QUOTE at TODAY'S
// prices (owner, 2026-11-03):
//
//   - A catalog item is priced at its retail now (catalogListUnits). A custom or
//     configured item is its own product, written at the price it was sold at
//     (create-from-cart mints it with that retail), so it keeps that price.
//   - No discount comes across. A copied discount would skip the store's
//     discount policy (GAP-06); staff give it again, under the policy.
//   - The delivery fee is the zone's fee today, when the original charged one.
//
// What comes across is the goods and who they are for: each line (product,
// options, quantity, how it is fulfilled, its note), the customer, the store
// and how it is delivered. What happened on the original does not: payments,
// holds, flags, disclaimers, order notes, history. A cancelled or replaced line
// is not part of the sale (rule 33), and neither is a zero-quantity line (rule
// 31) or a line given back on an exchange.
//
// Every number goes through the functions a register sale uses -- priceCart,
// resolveTaxDistrict / rateForLineAmount, saleUnitCost, nextOrderNumber,
// setDeliveryFee -- so a copy is priced exactly as the same cart rung up today.
// A quote that holds nothing commits no stock (GAP-16), so nothing is
// allocated until it becomes an order.

import type { Prisma } from "@prisma/client";
import { priceCart } from "@/lib/pos/cartPricing";
import {
  LINE_TAX_GROUP_SELECT,
  lineTaxGroupOf,
  rateForLineAmount,
  resolveTaxDistrict,
} from "@/lib/tax/resolveTaxRate";
import { catalogListUnits, existingListUnit } from "@/lib/sales/discountApproval";
import { saleUnitCost } from "@/lib/purchasing/landedCostShared";
import { nextOrderNumber } from "@/lib/orderNumber";
import { effectivePrefix } from "@/lib/numberingPrefix";
import { orderDeliveryZip, quoteDeliveryFee, setDeliveryFee } from "@/lib/delivery/deliveryFee";
import { deliveryPieces } from "@/lib/delivery/deliveryFeeShared";

type Tx = Prisma.TransactionClient;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class DuplicateOrderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "DuplicateOrderError";
  }
}

type NumberingSettings = Parameters<typeof effectivePrefix>[0] & { timezone: string };

export interface DuplicateOrderInput {
  orderId: number;
  /** Who is writing the copy: its salesperson, as a register sale records it. */
  actor: { email: string | null; displayName: string | null };
  settings: NumberingSettings;
  now?: Date;
}

const SOURCE_SELECT = {
  id: true,
  orderno: true,
  customerId: true,
  storeLocation: true,
  storeLocationId: true,
  deliveryMethod: true,
  deliveryAddressId: true,
  pickupLocationId: true,
  deliveryFeeLineItemId: true,
  returnFor: { select: { returnNumber: true } },
  lineItems: {
    // In the sale: not cancelled or replaced (rule 33), more than nothing
    // (rule 31), and not given back (an exchange's negative lines). Not a gift
    // card: it's its own card's number, sold at the register, and copied as a
    // plain line it would be sold as goods and taxed (lib/sales/giftCardLines.ts).
    where: {
      lineItemStatus: { in: ["ACTIVE", "BACKORDERED"] },
      orderedQuantity: { gt: 0 },
      giftCardNumber: null,
    },
    orderBy: [{ lineNumber: "asc" }, { id: "asc" }],
    select: {
      id: true,
      productId: true,
      productName: true,
      partNo: true,
      orderedQuantity: true,
      netPrice: true,
      listPrice: true,
      cost: true,
      selectedGrade: true,
      selectedFinish: true,
      selectedOptions: true,
      vendorStyleId: true,
      source: true,
      fulfillment: true,
      notes: true,
      product: {
        select: { id: true, baseCost: true, landedCost: true, ...LINE_TAX_GROUP_SELECT },
      },
    },
  },
} satisfies Prisma.SalesOrderSelect;

type SourceLine = Prisma.SalesOrderGetPayload<{
  select: typeof SOURCE_SELECT;
}>["lineItems"][number];

async function loadSource(tx: Tx, orderId: number) {
  const source = await tx.salesOrder.findUnique({ where: { id: orderId }, select: SOURCE_SELECT });
  if (!source) throw new DuplicateOrderError("Order not found.", 404);
  if (source.returnFor) {
    throw new DuplicateOrderError(
      `This is return ${source.returnFor.returnNumber}'s own order: it can't be copied.`,
      409,
    );
  }
  const lines = source.lineItems.filter((l) => l.id !== source.deliveryFeeLineItemId);
  if (lines.length === 0) {
    throw new DuplicateOrderError(
      "This order has nothing to copy: every line is cancelled or a gift card.",
    );
  }
  return { ...source, lines };
}

/** A line's unit cost as written: what the copy carries when it has no product. */
function writtenUnitCost(line: SourceLine): number {
  const qty = Number(line.orderedQuantity);
  return qty > 0 ? Number(line.cost) / qty : 0;
}

/** The copy's delivery fee: the zone's today, when the original charged one. */
async function copyDeliveryFee(
  tx: Tx,
  source: Awaited<ReturnType<typeof loadSource>>,
  copyId: number,
  actor: string | null,
): Promise<void> {
  if (source.deliveryFeeLineItemId == null || source.deliveryMethod !== "DELIVERY") return;
  const quote = await quoteDeliveryFee(tx, {
    zip: await orderDeliveryZip(tx, source),
    pieces: deliveryPieces(
      source.lines.map((l) => ({
        quantity: Number(l.orderedQuantity),
        goods: l.productId != null,
        takeWith: l.fulfillment === "TAKE",
      })),
    ),
  });
  // No zone delivers there any more: the copy charges nothing, and staff set
  // a fee on it as on any order.
  if (quote.amount) await setDeliveryFee(tx, { orderId: copyId, amount: quote.amount, actor });
}

export async function duplicateOrder(
  tx: Tx,
  input: DuplicateOrderInput,
): Promise<{ id: number; orderno: string }> {
  const source = await loadSource(tx, input.orderId);
  const { lines } = source;
  const now = input.now ?? new Date();

  // Today's list price: the product's retail now; a line with no product keeps
  // the unit price it was listed at.
  const listUnits = await catalogListUnits(
    tx,
    lines.map((l) => ({ productId: l.productId, unitPrice: existingListUnit(l) })),
  );
  const taxDistrict = await resolveTaxDistrict(tx, {
    customerId: source.customerId,
    storeLocationId: source.storeLocationId,
    contextLabel: source.storeLocation || "(no store on order)",
  });
  // Priced as create-from-cart prices a cart: once untaxed to learn each line's
  // amount, which picks its tax band, then with each line's own rate.
  const cart = lines.map((l, i) => ({
    unitPrice: listUnits[i],
    quantity: Number(l.orderedQuantity),
  }));
  const rates = priceCart(cart).items.map(
    (line, i) =>
      rateForLineAmount(taxDistrict.rules, line.netPrice, lineTaxGroupOf(lines[i].product)).rate,
  );
  const priced = priceCart(cart, { taxRate: rates });

  const orderno = await nextOrderNumber(
    tx,
    effectivePrefix(input.settings, "orderNumberPrefix"),
    input.settings.timezone,
    now,
  );
  const copy = await tx.salesOrder.create({
    data: {
      orderno,
      orderDate: now,
      quoteDate: now,
      status: "QUOTE",
      customerId: source.customerId,
      taxDistrictId: taxDistrict.taxDistrictId,
      taxExemptReasonId: taxDistrict.taxExemptReasonId,
      salesperson: input.actor.displayName || input.actor.email,
      storeLocation: source.storeLocation,
      storeLocationId: source.storeLocationId,
      deliveryMethod: source.deliveryMethod,
      deliveryAddressId: source.deliveryAddressId,
      pickupLocationId: source.pickupLocationId,
      createdBy: input.actor.email,
      totalTax: priced.taxAmount,
      lineItems: {
        create: lines.map((l, i) => ({
          lineNumber: i + 1,
          productId: l.productId,
          productName: l.productName,
          partNo: l.partNo,
          barcode: "",
          orderedQuantity: l.orderedQuantity,
          netPrice: priced.items[i].netPrice,
          listPrice: listUnits[i],
          // OrderLineItem.cost is the LINE total, like netPrice.
          cost: saleUnitCost(l.product, writtenUnitCost(l)) * Number(l.orderedQuantity),
          vatRate: rates[i],
          vatAmount: priced.items[i].vatAmount,
          selectedGrade: l.selectedGrade,
          selectedFinish: l.selectedFinish,
          selectedOptions: l.selectedOptions,
          vendorStyleId: l.vendorStyleId,
          source: l.source,
          fulfillment: l.fulfillment,
          notes: l.notes,
        })),
      },
    },
    select: { id: true, orderno: true },
  });

  await copyDeliveryFee(tx, source, copy.id, input.actor.email);
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: copy.id,
      changeType: "COPIED_FROM",
      newValue: source.orderno,
      changedBy: input.actor.email,
    },
  });
  return copy;
}
