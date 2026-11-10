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
import { getActiveOrderLines, resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { lockProducts } from "@/lib/inventory/ledger";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { generateAppointmentNumber } from "@/lib/serviceDispatchService";

type Tx = Prisma.TransactionClient;

/** DROP_SHIP: the vendor took it to the customer (GAP-20, DECISIONS 55). */
export type HandoverMethod = "DELIVERY" | "PICKUP" | "TAKEN" | "DROP_SHIP";

export interface HandoverInput {
  salesOrderId: number;
  /** When it actually happened -- the stop's completedAt, or now for a counter
   *  sale. Never defaulted here: the caller knows, and a guessed revenue date
   *  is not a defensible one. */
  at: Date;
  method: HandoverMethod;
  /** For the audit row. */
  actor?: string | null;
  /** The run whose stop this is: its truck is where the goods were. */
  deliveryRunId?: number | null;
  /** The stop it was completed from, so an undo can put it back (GAP-07). */
  deliveryStopId?: number | null;
}

/**
 * Where a delivered unit most likely was, in order: on the run's truck (a
 * place of the run's own, truck.ts), then at a loading bay. Drawn from before
 * anywhere else the order holds the product, so the units that leave the books
 * are the ones that went, and none are left reading as on the truck.
 */
function deliveredFrom(deliveryRunId?: number | null): Prisma.InventoryPositionWhereInput[] {
  return [
    ...(deliveryRunId != null ? [{ stockLocation: { deliveryRunId } }] : []),
    { stockLocation: { locationType: "STAGING" } },
  ];
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
    select: {
      id: true,
      deliveredAt: true,
      status: true,
      dispatchStatus: true,
      storeLocation: true,
    },
  });

  if (existing.status === "CANCELLED") {
    throw new Error("This order is cancelled, so it can't be handed over.");
  }
  if (existing.deliveredAt) {
    return { changed: false, deliveredAt: existing.deliveredAt };
  }

  // What this handover changes, recorded first, so one made by mistake can be
  // undone exactly (GAP-07, undoHandover.ts): the dispatch status and each open
  // line's fulfilled quantity before it, and the stock it moves (below).
  const before = await tx.orderLineItem.findMany({
    where: { salesOrderId: input.salesOrderId, lineItemStatus: "ACTIVE" },
    select: { id: true, fulfilledQty: true },
  });
  const handover = await tx.orderHandover.create({
    data: {
      salesOrderId: input.salesOrderId,
      method: input.method,
      at: input.at,
      deliveryRunId: input.deliveryRunId ?? null,
      deliveryStopId: input.deliveryStopId ?? null,
      previousDispatchStatus: existing.dispatchStatus,
      linesBefore: before.map((l) => ({
        lineItemId: l.id,
        fulfilledQty: toQty(l.fulfilledQty),
      })),
      actor: input.actor ?? null,
    },
    select: { id: true },
  });

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
      // How the customer got it. A drop ship keeps the sale's own method: the vendor's
      // delivery isn't one of the store's (DeliveryMethod has no value for it).
      ...(input.method === "DROP_SHIP" ? {} : { deliveryMethod: input.method }),
      updatedBy: input.actor ?? null,
    },
  });

  // Handed over straight from a quote: as a quote it committed only the lines
  // it held (GAP-16), so commit the rest as the order it now is before taking
  // any out -- otherwise the unheld lines' units would stay on the books.
  if (existing.status === "QUOTE") {
    await resyncOrderAllocation(input.salesOrderId, existing.storeLocation, tx);
  }

  // The goods left the building, so the stock did too. This used to happen only
  // as a side effect of the two status endpoints -- a completed delivery never
  // called it, so physically delivered stock stayed committed on the books.
  // Only what is still to fulfil: a part delivery already took the rest.
  const lines = await getActiveOrderLines(input.salesOrderId, tx);
  await consume(
    input.salesOrderId,
    lines,
    tx,
    input.method === "DELIVERY" ? deliveredFrom(input.deliveryRunId) : [],
    handover.id,
  );
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
    await consume(
      input.salesOrderId,
      [{ productId: line.productId!, quantity }],
      tx,
      deliveredFrom(input.deliveryRunId),
    );
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
 * A drop-shipped PO was received (GAP-20, DECISIONS 55): the vendor took those lines to
 * the customer. Owner, 2026-11-10: "once received we assume the customer has it". The
 * lines delivered are marked fulfilled; when that's the last of the sale, it's the
 * handover (markHandedOver), as a delivery's last stop is. Nothing is consumed, since a drop-shipped line
 * holds no store stock. A quantity past what's still to deliver is ignored, and a sale
 * that's cancelled or not yet a sale is left alone.
 *
 * Runs in the receipt's transaction.
 */
export async function deliverDropShipped(
  tx: Tx,
  input: { salesOrderId: number; at: Date; actor: string | null; lines: DeliveredLine[] },
): Promise<DeliveryResult> {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: input.salesOrderId },
    select: {
      status: true,
      deliveredAt: true,
      lineItems: {
        where: { lineItemStatus: "ACTIVE", productId: { not: null }, orderedQuantity: { gt: 0 } },
        select: {
          id: true,
          productName: true,
          product: { select: { name: true } },
          orderedQuantity: true,
          fulfilledQty: true,
        },
      },
    },
  });
  if (order.deliveredAt || (order.status !== "ORDER" && order.status !== "FULFILLED")) {
    return { changed: false, complete: Boolean(order.deliveredAt), restAppointmentId: null };
  }

  const left = new Map(
    order.lineItems.map((l) => [l.id, roundQty(toQty(l.orderedQuantity) - toQty(l.fulfilledQty))]),
  );
  const going = new Map<number, number>();
  for (const d of input.lines) {
    const open = left.get(d.orderLineItemId);
    if (open === undefined) continue;
    const quantity = Math.min(open - (going.get(d.orderLineItemId) ?? 0), d.quantity);
    if (quantity > 0) {
      going.set(d.orderLineItemId, roundQty((going.get(d.orderLineItemId) ?? 0) + quantity));
    }
  }
  if (going.size === 0) return { changed: false, complete: false, restAppointmentId: null };

  const names = new Map(
    order.lineItems.map((l) => [l.id, l.productName ?? l.product?.name ?? `line ${l.id}`]),
  );
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: input.salesOrderId,
      changeType: "DROP_SHIPPED",
      newValue: [...going].map(([id, q]) => `${names.get(id)} x${q}`).join("; "),
      changedBy: input.actor ?? "system",
    },
  });

  const complete = [...left].every(([id, open]) => roundQty(open - (going.get(id) ?? 0)) <= 0);
  if (complete) {
    await markHandedOver(tx, {
      salesOrderId: input.salesOrderId,
      at: input.at,
      method: "DROP_SHIP",
      actor: input.actor,
    });
    return { changed: true, complete: true, restAppointmentId: null };
  }
  for (const [lineId, quantity] of going) {
    await tx.orderLineItem.update({
      where: { id: lineId },
      data: { fulfilledQty: { increment: quantity } },
    });
  }
  return { changed: true, complete: false, restAppointmentId: null };
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
