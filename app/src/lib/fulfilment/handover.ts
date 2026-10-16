// /app/src/lib/fulfilment/handover.ts
//
// ONE FACT: the goods reached the customer.
//
// holt has three fulfilment methods and, before this file, three different
// places that half-recorded the moment:
//
//   DELIVERY  -> DeliveryStop.status = COMPLETED, and nothing else. A signed,
//                photographed, completed delivery left the SalesOrder entirely
//                untouched: still ORDER, stock still committed, money still a
//                deposit -- permanently, unless somebody separately clicked a
//                different button on a different screen.
//   PICKUP    -> SalesOrder.dispatchStatus = FULFILLED, from the warehouse queue.
//   TAKEN     -> nothing at all.
//
// And a fourth flag, SalesOrder.status = FULFILLED, moved independently of all
// of them from a dropdown with no delivery evidence behind it.
//
// So "is this delivered?" had no answer. That is why revenue recognition had
// nothing to key on, why CommissionPlan.countsWhen = DELIVERED was an inert
// no-op, and why the two FULFILLED flags could disagree indefinitely.
//
// Every handover now goes through markHandedOver(), which writes the fact once
// and does everything that follows from it. Callers supply the evidence; this
// decides the consequences.

//
// A part delivery (recordDelivery below) is not a handover: the truck left
// some of the order behind. It hands over the units that went -- stock out,
// OrderLineItem.fulfilledQty up -- and the order stays open for the rest,
// with a fresh DELIVERY appointment in the dispatch pool so the rest is not
// forgotten. When the last units go, it is the handover, through
// markHandedOver, which then consumes only what was still to fulfil.

import type { Prisma } from "@prisma/client";
import { consume } from "@/lib/inventory/allocation";
import { getActiveOrderLines } from "@/lib/inventory/orderInventorySync";
import { drawLegs, lockProducts, postMovement } from "@/lib/inventory/ledger";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { generateAppointmentNumber } from "@/lib/serviceDispatchService";

type Tx = Prisma.TransactionClient;

export type HandoverMethod = "DELIVERY" | "PICKUP" | "TAKEN";

export interface HandoverInput {
  salesOrderId: number;
  /** When it actually happened -- the stop's completedAt, or now for a counter
   *  sale. Never defaulted here: the caller knows, and a guessed revenue date
   *  is not a defensible one. */
  at: Date;
  method: HandoverMethod;
  /** For the audit row. */
  actor?: string | null;
}

export interface HandoverResult {
  /** False when the order was already handed over -- the second call is a
   *  no-op, not an error. */
  changed: boolean;
  deliveredAt: Date;
}

/**
 * Which handover this is, from the order's recorded fulfilment method.
 *
 * DELIVERY is the fallback rather than a guess: an order with no method set is
 * one nobody told us about, and a van drop is the assumption that costs least
 * if wrong -- it is the only one that leaves a delivery record to check.
 */
export function handoverMethodFor(deliveryMethod: string | null | undefined): HandoverMethod {
  if (deliveryMethod === "TAKEN") return "TAKEN";
  if (deliveryMethod === "PICKUP") return "PICKUP";
  return "DELIVERY";
}

/**
 * Record that an order reached the customer, and do everything that follows.
 *
 * IDEMPOTENT BY CONSTRUCTION. `deliveredAt` is the guard: once set, a repeat
 * call returns `changed: false` and touches nothing. That matters because the
 * driver app fires stop-complete and run-complete as separate requests over a
 * truck's connection, where retries are routine -- and because consuming stock
 * twice would relieve inventory the business still owns.
 *
 * Runs inside the caller's transaction so the handover, the stock movement and
 * the audit row commit together or not at all.
 */
export async function markHandedOver(tx: Tx, input: HandoverInput): Promise<HandoverResult> {
  const existing = await tx.salesOrder.findUniqueOrThrow({
    where: { id: input.salesOrderId },
    select: { id: true, deliveredAt: true, status: true, dispatchStatus: true },
  });

  if (existing.deliveredAt) {
    return { changed: false, deliveredAt: existing.deliveredAt };
  }

  await tx.salesOrder.update({
    where: { id: input.salesOrderId },
    data: {
      deliveredAt: input.at,
      // Both flags, together, always. They were written by two different
      // endpoints that never wrote each other's field, so an order could sit
      // in status=FULFILLED / dispatchStatus=PO_PLACED indefinitely and no
      // report could tell which one to believe.
      status: "FULFILLED",
      dispatchStatus: "FULFILLED",
      deliveryMethod: input.method,
      updatedBy: input.actor ?? null,
    },
  });

  // The goods left the building, so the stock did too. This used to happen only
  // as a side effect of the two status endpoints -- a completed delivery never
  // called it, so physically delivered stock stayed committed on the books.
  // Only what is still to fulfil: a part delivery already took the rest.
  const lines = await getActiveOrderLines(input.salesOrderId, tx);
  await consume(input.salesOrderId, lines, tx);
  const open = await tx.orderLineItem.findMany({
    where: {
      salesOrderId: input.salesOrderId,
      lineItemStatus: "ACTIVE",
      orderedQuantity: { gt: 0 },
    },
    select: { id: true, orderedQuantity: true },
  });
  for (const line of open) {
    await tx.orderLineItem.update({
      where: { id: line.id },
      data: { fulfilledQty: line.orderedQuantity },
    });
  }

  await tx.orderChangeLog.create({
    data: {
      salesOrderId: input.salesOrderId,
      changeType: "HANDED_OVER",
      newValue: `${input.method} at ${input.at.toISOString()}`,
      changedBy: input.actor ?? "system",
    },
  });

  return { changed: true, deliveredAt: input.at };
}

export class DeliveryError extends Error {}

export interface DeliveredLine {
  orderLineItemId: number;
  quantity: number;
}

export interface DeliveryResult {
  /** False when the order was already handed over. */
  changed: boolean;
  /** Everything has now reached the customer: this was the handover. */
  complete: boolean;
  /** A part delivery: the DELIVERY appointment opened for the rest. */
  restAppointmentId: number | null;
}

/**
 * What a delivery stop handed over, line by line. Product lines not listed, or
 * listed with less than is still to fulfil, stay with the order: their units
 * are still committed to it (on the truck or at the loading bay) and go out on
 * a later run. Lines with no product (a delivery fee, a service) are not
 * goods and play no part.
 *
 * Runs in the caller's transaction; the caller makes it happen once (the stop
 * route claims the stop before calling).
 */
export async function recordDelivery(
  tx: Tx,
  input: HandoverInput & { lines: DeliveredLine[]; appointmentId?: number | null },
): Promise<DeliveryResult> {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: input.salesOrderId },
    select: {
      orderno: true,
      deliveredAt: true,
      lineItems: {
        where: { lineItemStatus: "ACTIVE", productId: { not: null }, orderedQuantity: { gt: 0 } },
        select: {
          id: true,
          productId: true,
          productName: true,
          product: { select: { name: true } },
          orderedQuantity: true,
          fulfilledQty: true,
        },
      },
    },
  });
  if (order.deliveredAt) return { changed: false, complete: true, restAppointmentId: null };

  const open = new Map(
    order.lineItems.map((l) => [
      l.id,
      {
        ...l,
        name: l.productName ?? l.product?.name ?? `line ${l.id}`,
        left: roundQty(toQty(l.orderedQuantity) - toQty(l.fulfilledQty)),
      },
    ]),
  );
  const delivered = new Map<number, number>();
  for (const d of input.lines) {
    const line = open.get(Number(d.orderLineItemId));
    if (!line) throw new DeliveryError("A delivered line is not an open line of this order.");
    if (!Number.isFinite(d.quantity) || d.quantity < 0) {
      throw new DeliveryError("A delivered quantity cannot be negative.");
    }
    const total = roundQty((delivered.get(line.id) ?? 0) + d.quantity);
    if (total > line.left) {
      throw new DeliveryError(`${line.name}: only ${line.left} still to deliver, not ${total}.`);
    }
    delivered.set(line.id, total);
  }

  const complete = [...open.values()].every(
    (l) => roundQty(l.left - (delivered.get(l.id) ?? 0)) <= 0,
  );
  if (complete) {
    // The last of it went: this is the handover, and it consumes the rest.
    await markHandedOver(tx, input);
    return { changed: true, complete: true, restAppointmentId: null };
  }

  const going = [...delivered].filter(([, q]) => q > 0);
  if (going.length === 0) {
    // Nothing went: that is a stop that could not be done, not a delivery.
    throw new DeliveryError("Nothing was delivered: use Couldn't deliver instead.");
  }
  await lockProducts(
    tx,
    going.map(([id]) => open.get(id)!.productId!),
  );
  for (const [lineId, quantity] of going) {
    const line = open.get(lineId)!;
    await consumeDelivered(tx, input.salesOrderId, line.productId!, quantity);
    await tx.orderLineItem.update({
      where: { id: lineId },
      data: { fulfilledQty: { increment: quantity } },
    });
  }

  const rest = await openRestAppointment(tx, input.salesOrderId, input.appointmentId ?? null);
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: input.salesOrderId,
      changeType: "PARTLY_DELIVERED",
      newValue: going.map(([id, q]) => `${open.get(id)!.name} x${q}`).join("; "),
      changedBy: input.actor ?? "system",
    },
  });
  return { changed: true, complete: false, restAppointmentId: rest };
}

/**
 * Units handed over, out of stock: from the loading bay first (that is where
 * a loaded unit sits), then wherever else the order holds it.
 */
async function consumeDelivered(
  tx: Tx,
  salesOrderId: number,
  productId: number,
  quantity: number,
): Promise<void> {
  let left = quantity;
  for (const where of [
    { salesOrderId, stockLocation: { locationType: "STAGING" as const } },
    { salesOrderId },
  ]) {
    if (!(left > 0)) break;
    const { legs, shortfall } = await drawLegs(tx, { productId, where, quantity: left });
    for (const leg of legs) {
      await postMovement(tx, {
        productId,
        quantity: leg.take,
        from: leg.place,
        reason: "DELIVER",
        source: { type: "SalesOrder", id: salesOrderId },
      });
    }
    left = shortfall;
  }
}

/** A DELIVERY appointment for what is left, in the dispatch pool (no stop). */
async function openRestAppointment(
  tx: Tx,
  salesOrderId: number,
  fromAppointmentId: number | null,
): Promise<number> {
  const from = fromAppointmentId
    ? await tx.serviceAppointment.findUnique({ where: { id: fromAppointmentId } })
    : null;
  const appt = await tx.serviceAppointment.create({
    data: {
      appointmentNumber: await generateAppointmentNumber(),
      type: "DELIVERY",
      status: "PENDING",
      salesOrderId,
      customerId: from?.customerId ?? null,
      addressId: from?.addressId ?? null,
      storeLocationId: from?.storeLocationId ?? null,
      deliveryZoneId: from?.deliveryZoneId ?? null,
      accessInstructions: from?.accessInstructions ?? null,
      notes: `The rest of a part delivery${from ? ` (${from.appointmentNumber})` : ""}`,
      createdBy: "dispatch",
    },
    select: { id: true },
  });
  return appt.id;
}
