// /app/src/lib/delivery/deliveryFee.ts
//
// GAP-09: an order charges its delivery zone's fee.
//
// DeliveryZone.baseFee and perPieceFee were stored and shown, and nothing put
// them on an order. The fee is a line with no product: not goods, so nothing
// allocates, picks or hands it over (lib/fulfilment/handover.ts). The order
// says which line it is (SalesOrder.deliveryFeeLineItemId), the same way a
// return says which line is its restocking fee, so nothing has to recognise it
// by name:
//   - it is taxed under AppSettings.deliveryFeeTaxGroupId, because whether
//     delivery is taxed is state law and the store's to say;
//   - the journal books it to POS Transactions/"Delivery Fee", and a fee is
//     refused while that is unmapped rather than booked to no account;
//   - sales credit leaves it out (salesBySalesperson.ts buildLineItemWhere);
//   - the generic line routes and returns refuse it (deliveryFeeLineEditProblem):
//     it changes only through setDeliveryFee, which keeps its tax right.
//
// Every writer goes through setDeliveryFee: the register's sale
// (create-from-cart.ts) and the order screen (orders/[id]/delivery-fee.ts).

import type { PrismaTx } from "@/lib/inventory/allocation";
import { DELIVERY_FEE_MAPPING_LABEL, POS_TRANSACTIONS_SECTION } from "@/lib/glMapping";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import { type LineTaxGroup, rateForLineAmount, resolveTaxDistrict } from "@/lib/tax/resolveTaxRate";
import {
  type DeliveryFeeQuote,
  type OrderDeliveryFee,
  deliveryFeeProblem,
  deliveryPieces,
  zoneFee,
} from "./deliveryFeeShared";

export class DeliveryFeeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "DeliveryFeeError";
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Orders whose fee may change: not yet handed over, cancelled or returned. */
const FEE_EDITABLE_STATUSES: ReadonlySet<string> = new Set(["QUOTE", "ORDER"]);

/** Whether an order in this status may still have its fee changed. */
export function feeIsEditable(status: string): boolean {
  return FEE_EDITABLE_STATUSES.has(status);
}

export interface DeliveryZoneFees {
  id: number;
  name: string;
  baseFee: number;
  perPieceFee: number | null;
}

/**
 * The active zone that delivers to a ZIP, by its first five digits (a ZIP+4
 * is the same zone). A switched-off zone delivers nowhere. A ZIP listed in two
 * zones goes to the first in the zones' own order.
 */
export async function zoneForZip(
  db: PrismaTx,
  zip: string | null | undefined,
): Promise<DeliveryZoneFees | null> {
  const zip5 = zip?.trim().slice(0, 5);
  if (!zip5) return null;
  const match = await db.deliveryZoneZip.findFirst({
    where: { zipCode: zip5, deliveryZone: { isActive: true } },
    orderBy: [{ deliveryZone: { sortOrder: "asc" } }, { deliveryZoneId: "asc" }],
    select: {
      deliveryZone: { select: { id: true, name: true, baseFee: true, perPieceFee: true } },
    },
  });
  if (!match) return null;
  const z = match.deliveryZone;
  return {
    id: z.id,
    name: z.name,
    baseFee: Number(z.baseFee),
    perPieceFee: z.perPieceFee == null ? null : Number(z.perPieceFee),
  };
}

/** A customer's first address on file: where a delivery goes with no other said. */
export async function customerZip(
  db: PrismaTx,
  customerId: number | null | undefined,
): Promise<string | null> {
  if (customerId == null) return null;
  const address = await db.customerAddress.findFirst({
    where: { customerId },
    orderBy: { id: "asc" },
    select: { zip: true },
  });
  return address?.zip ?? null;
}

/** Where an order is delivered: its delivery address, else its customer's. */
export async function orderDeliveryZip(
  db: PrismaTx,
  order: { deliveryAddressId: number | null; customerId: number | null },
): Promise<string | null> {
  if (order.deliveryAddressId != null) {
    const address = await db.customerAddress.findUnique({
      where: { id: order.deliveryAddressId },
      select: { zip: true },
    });
    if (address?.zip) return address.zip;
  }
  return customerZip(db, order.customerId);
}

/** What the zone delivering to this ZIP charges for this many pieces. */
export async function quoteDeliveryFee(
  db: PrismaTx,
  input: { zip: string | null; pieces: number },
): Promise<DeliveryFeeQuote> {
  const zone = await zoneForZip(db, input.zip);
  return {
    zip: input.zip,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    pieces: input.pieces,
    amount: zone ? zoneFee(zone, input.pieces) : null,
  };
}

/** The tax group delivery fees sell under (null: the district's rules). */
export async function deliveryFeeTaxGroup(db: PrismaTx): Promise<LineTaxGroup | null> {
  // Single-org-per-deployment (docs/TENANCY.md): at most one AppSettings row.
  const settings = await db.appSettings.findFirst({
    select: { deliveryFeeTaxGroup: { select: { id: true, exempt: true } } },
  });
  return settings?.deliveryFeeTaxGroup ?? null;
}

/** Why a generic line route may not touch this line, or null when it may. */
export async function deliveryFeeLineEditProblem(
  db: PrismaTx,
  lineItemId: number,
): Promise<string | null> {
  const line = await db.orderLineItem.findUnique({
    where: { id: lineItemId },
    select: { deliveryFeeFor: { select: { id: true } } },
  });
  return line?.deliveryFeeFor
    ? "This line is the order's delivery fee: change or remove it under Delivery fee on the order."
    : null;
}

/** The order's pieces going out on the truck (deliveryPieces), from its lines. */
async function orderPieces(db: PrismaTx, orderId: number, feeLineId: number | null) {
  const lines = await db.orderLineItem.findMany({
    where: { salesOrderId: orderId, lineItemStatus: { not: "CANCELLED" } },
    select: { id: true, productId: true, orderedQuantity: true, fulfillment: true },
  });
  return deliveryPieces(
    lines
      .filter((l) => l.id !== feeLineId)
      .map((l) => ({
        quantity: Number(l.orderedQuantity),
        goods: l.productId != null,
        takeWith: l.fulfillment === "TAKE",
      })),
  );
}

/** The order's fee now and what its zone would charge (the order screen's GET). */
export async function orderDeliveryFee(db: PrismaTx, orderId: number): Promise<OrderDeliveryFee> {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      customerId: true,
      deliveryAddressId: true,
      deliveryFeeLine: { select: { id: true, netPrice: true, vatAmount: true } },
    },
  });
  if (!order) throw new DeliveryFeeError("Order not found.", 404);
  const fee = order.deliveryFeeLine;
  const zip = await orderDeliveryZip(db, order);
  const pieces = await orderPieces(db, orderId, fee?.id ?? null);
  return {
    current: fee
      ? { lineItemId: fee.id, amount: Number(fee.netPrice), taxAmount: Number(fee.vatAmount) }
      : null,
    quote: await quoteDeliveryFee(db, { zip, pieces }),
  };
}

async function assertFeeAccountMapped(tx: PrismaTx): Promise<void> {
  const mapping = await tx.systemGLMapping.findUnique({
    where: {
      section_label: { section: POS_TRANSACTIONS_SECTION, label: DELIVERY_FEE_MAPPING_LABEL },
    },
    select: { glAccountId: true },
  });
  if (!mapping?.glAccountId) {
    throw new DeliveryFeeError(
      `A delivery fee needs an income account: map "${DELIVERY_FEE_MAPPING_LABEL}" under POS Transactions in Admin › Setup › Accounting first.`,
    );
  }
}

export interface SetDeliveryFeeResult {
  /** The fee line, or null when the order now charges no delivery. */
  lineItemId: number | null;
  amount: number;
  taxAmount: number;
}

/**
 * Charge an order this delivery fee, change it, or (null or 0) remove it.
 * Runs in the caller's transaction. The line is taxed as any line added to the
 * order is (line-items.ts): the order's customer and store decide the district,
 * and the delivery tax group decides the rate. The order's totalTax is summed
 * again from its lines.
 */
export async function setDeliveryFee(
  tx: PrismaTx,
  input: { orderId: number; amount: number | null; actor: string | null },
): Promise<SetDeliveryFeeResult> {
  const amount = input.amount ?? 0;
  const problem = deliveryFeeProblem(amount);
  if (problem) throw new DeliveryFeeError(problem);
  const fee = round2(amount);

  const order = await loadFeeEditableOrder(tx, input.orderId);
  const result =
    fee === 0
      ? await removeFeeLine(tx, order, input.actor)
      : await writeFeeLine(tx, order, fee, input.actor);

  // Cancelled lines are out of every sum (CLAUDE.md rule 33).
  const taxed = await tx.orderLineItem.aggregate({
    where: { salesOrderId: order.id, lineItemStatus: { not: "CANCELLED" } },
    _sum: { vatAmount: true },
  });
  await tx.salesOrder.update({
    where: { id: order.id },
    data: {
      deliveryFeeLineItemId: result.lineItemId,
      totalTax: round2(Number(taxed._sum.vatAmount ?? 0)),
      updatedBy: input.actor,
    },
  });
  return result;
}

type FeeEditableOrder = Awaited<ReturnType<typeof loadFeeEditableOrder>>;

/** The order, if its fee may change: open, and not a native return's own. */
async function loadFeeEditableOrder(tx: PrismaTx, orderId: number) {
  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderno: true,
      status: true,
      customerId: true,
      storeLocationId: true,
      deliveryAddressId: true,
      deliveryFeeLine: { select: { id: true, netPrice: true } },
    },
  });
  if (!order) throw new DeliveryFeeError("Order not found.", 404);
  if (!feeIsEditable(order.status)) {
    throw new DeliveryFeeError(
      `This order is ${order.status.toLowerCase()}: its delivery fee can no longer change.`,
      409,
    );
  }
  const locked = await returnOrderEditProblem(tx, order.id);
  if (locked) throw new DeliveryFeeError(locked, 409);
  return order;
}

async function removeFeeLine(
  tx: PrismaTx,
  order: FeeEditableOrder,
  actor: string | null,
): Promise<SetDeliveryFeeResult> {
  const existing = order.deliveryFeeLine;
  if (existing) {
    await tx.orderLineItem.delete({ where: { id: existing.id } });
    const previous = Number(existing.netPrice);
    await logChange(tx, order.id, existing.id, "LINE_REMOVED", previous, null, actor);
  }
  return { lineItemId: null, amount: 0, taxAmount: 0 };
}

async function writeFeeLine(
  tx: PrismaTx,
  order: FeeEditableOrder,
  fee: number,
  actor: string | null,
): Promise<SetDeliveryFeeResult> {
  await assertFeeAccountMapped(tx);
  const zone = await zoneForZip(tx, await orderDeliveryZip(tx, order));
  const taxDistrict = await resolveTaxDistrict(tx, {
    customerId: order.customerId,
    storeLocationId: order.storeLocationId,
    contextLabel: `order ${order.orderno ?? order.id}`,
  });
  const rate = rateForLineAmount(taxDistrict.rules, fee, await deliveryFeeTaxGroup(tx)).rate;
  const taxAmount = round2(fee * rate);
  const existingId = order.deliveryFeeLine?.id ?? null;
  const line = {
    productName: zone ? `Delivery — ${zone.name}` : "Delivery",
    netPrice: fee,
    // Listed at the zone's fee, so a fee cut below it shows as a saving and
    // counts as a discount (GAP-06). With no zone, the fee is its own list.
    listPrice: zone ? zoneFee(zone, await orderPieces(tx, order.id, existingId)) : fee,
    vatRate: rate,
    vatAmount: taxAmount,
  };

  const existing = order.deliveryFeeLine;
  if (existing) {
    await tx.orderLineItem.update({ where: { id: existing.id }, data: line });
    const previous = Number(existing.netPrice);
    if (fee !== previous) {
      await logChange(tx, order.id, existing.id, "PRICE_CHANGE", previous, fee, actor);
    }
    return { lineItemId: existing.id, amount: fee, taxAmount };
  }

  const last = await tx.orderLineItem.findFirst({
    where: { salesOrderId: order.id },
    orderBy: { lineNumber: "desc" },
    select: { lineNumber: true },
  });
  const created = await tx.orderLineItem.create({
    data: {
      ...line,
      salesOrderId: order.id,
      lineNumber: (last?.lineNumber ?? 0) + 1,
      partNo: "",
      barcode: "",
      orderedQuantity: 1,
      cost: 0,
    },
    select: { id: true },
  });
  await logChange(tx, order.id, created.id, "LINE_ADDED", null, fee, actor);
  return { lineItemId: created.id, amount: fee, taxAmount };
}

async function logChange(
  tx: PrismaTx,
  salesOrderId: number,
  lineItemId: number,
  changeType: "LINE_ADDED" | "LINE_REMOVED" | "PRICE_CHANGE",
  previous: number | null,
  next: number | null,
  changedBy: string | null,
): Promise<void> {
  const money = (n: number | null) => (n == null ? null : `Delivery fee ${n.toFixed(2)}`);
  await tx.orderChangeLog.create({
    data: {
      salesOrderId,
      lineItemId,
      changeType,
      previousValue: money(previous),
      newValue: money(next),
      changedBy,
    },
  });
}
