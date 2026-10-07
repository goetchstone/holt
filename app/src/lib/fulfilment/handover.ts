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

import type { Prisma } from "@prisma/client";
import { consume } from "@/lib/inventory/allocation";
import { getActiveOrderLines } from "@/lib/inventory/orderInventorySync";

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
  const lines = await getActiveOrderLines(input.salesOrderId, tx);
  await consume(input.salesOrderId, lines, tx);

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
