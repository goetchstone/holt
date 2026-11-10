// /app/src/lib/fulfilment/undoHandover.ts
//
// GAP-07: undo a handover recorded by mistake -- a stop completed on the wrong
// order, a pickup marked collected that wasn't (owner, 2026-11-03).
//
// Handing over is terminal by design (deliveryService.ts): it recognises the
// sale. So the undo is not a reopen. It is the handover's exact reversal,
// read from what the handover recorded (OrderHandover, written by
// markHandedOver):
//
//   - its units come back on the books where they left from, still committed
//     to the order (reason UNDELIVER). A unit that left from a run's truck,
//     whose places leave service when the run completes, comes back to the
//     store's loading bay -- where an unloaded truck puts it (truck.ts);
//   - the order reopens: deliveredAt cleared, status ORDER, its dispatch status
//     as it was, each line's fulfilled quantity as it was;
//   - a delivery goes back in the dispatch pool: its stop comes off its run and
//     its appointment is pending again, with the reason on it.
//
// Only the latest handover, the one that set deliveredAt. A part delivery
// before it was its own stop, confirmed as it happened, and stays delivered.
//
// Refused:
//   - without "Undo a handover" (sales.undo-handover; managers by default) --
//     the route's gate;
//   - once commission on the order has been paid out: a paid payout for anyone
//     credited with the sale, for the period the sale counted in on their plan;
//   - once goods came back on a return against the order;
//   - for a handover recorded before this existed, which has no record of what
//     it moved.

import type { Prisma } from "@prisma/client";
import { postMovement, lockProducts, type Place } from "@/lib/inventory/ledger";
import { resolvePlanRulesForStaff } from "@/lib/commissionRules";

type Tx = Prisma.TransactionClient;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class UndoHandoverError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = "UndoHandoverError";
  }
}

export const UNDO_REASON_MAX = 500;

const REOPEN_THROUGH_UNDO =
  "This order has been handed over. To reopen it, a manager uses Undo handover, which puts its stock back too.";

/**
 * A handed-over order leaves FULFILLED only through Undo handover, which also
 * puts its stock back and clears deliveredAt. Changing its status, or its
 * dispatch status, alone left the goods off the books while the order read as
 * open. The one check both routes make (orders/[id], orders/[id]/dispatch).
 */
export function handedOverStatusProblem(
  order: { status: string; deliveredAt: Date | null },
  to: unknown,
): string | null {
  if (!order.deliveredAt || order.status !== "FULFILLED") return null;
  if (to === undefined || to === null || to === "" || to === "FULFILLED") return null;
  return REOPEN_THROUGH_UNDO;
}

/** The same for a dispatch status: FULFILLED stays until Undo handover. */
export function handedOverDispatchProblem(
  order: { deliveredAt: Date | null } | null,
  to: unknown,
): string | null {
  if (!order?.deliveredAt || to === undefined || to === "FULFILLED") return null;
  return REOPEN_THROUGH_UNDO;
}

export interface UndoHandoverResult {
  handoverId: number;
  /** Units put back on the books, committed to the order. */
  unitsBack: number;
}

/** What each method's dispatch status goes back to when none was recorded. */
const DISPATCH_BEFORE: Record<string, "SCHEDULED_DELIVERY" | "READY_FOR_PICKUP" | null> = {
  DELIVERY: "SCHEDULED_DELIVERY",
  PICKUP: "READY_FOR_PICKUP",
  TAKEN: null,
  DROP_SHIP: null,
};

function readReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) throw new UndoHandoverError("Say why the handover is being undone.", 400);
  if (reason.length > UNDO_REASON_MAX) {
    throw new UndoHandoverError(`Keep the reason under ${UNDO_REASON_MAX} characters.`, 400);
  }
  return reason;
}

/** The staff credited with the sale: by id, as split partner, or by the name on it. */
async function creditedStaff(
  tx: Tx,
  order: { salesPersonId: number | null; splitWithId: number | null; salesperson: string | null },
): Promise<{ id: number; displayName: string }[]> {
  const name = order.salesperson?.trim();
  return tx.staffMember.findMany({
    where: {
      OR: [
        ...(order.salesPersonId != null ? [{ id: order.salesPersonId }] : []),
        ...(order.splitWithId != null ? [{ id: order.splitWithId }] : []),
        ...(name
          ? [
              { displayName: { equals: name, mode: "insensitive" as const } },
              { aliases: { has: name } },
            ]
          : []),
      ],
    },
    select: { id: true, displayName: true },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Refuse when commission on the order has been paid to anyone credited with it. */
async function assertCommissionUnpaid(
  tx: Tx,
  order: {
    orderDate: Date | null;
    deliveredAt: Date;
    salesPersonId: number | null;
    splitWithId: number | null;
    salesperson: string | null;
  },
): Promise<void> {
  const staff = await creditedStaff(tx, order);
  if (staff.length === 0) return;
  const plans = await resolvePlanRulesForStaff(staff.map((s) => s.id));
  const paid = await tx.commissionPayout.findMany({
    where: { staffMemberId: { in: staff.map((s) => s.id) }, paidOn: { not: null } },
    select: { staffMemberId: true, periodStart: true, periodEnd: true },
  });
  for (const payout of paid) {
    // The date the sale counted in on this person's plan (commissionSales.ts).
    const counted =
      plans.get(payout.staffMemberId)?.countsWhen === "DELIVERED"
        ? order.deliveredAt
        : order.orderDate;
    if (!counted) continue;
    // A payout's periodEnd is the period's last day (runCommissionPayouts.ts).
    const inPeriod =
      counted >= payout.periodStart && counted.getTime() < payout.periodEnd.getTime() + DAY_MS;
    if (inPeriod) {
      const who = staff.find((s) => s.id === payout.staffMemberId)?.displayName ?? "a salesperson";
      throw new UndoHandoverError(
        `Commission on this order has been paid to ${who}, so its handover can't be undone.`,
      );
    }
  }
}

/** Where a unit that left from `from` comes back: there, or a loading bay if it was a finished run's truck. */
async function placeBack(
  tx: Tx,
  from: { storeLocationId: number; stockLocationId: number },
  salesOrderId: number,
): Promise<Place> {
  const place = await tx.stockLocation.findUnique({
    where: { id: from.stockLocationId },
    select: { isActive: true, deliveryRunId: true },
  });
  if (place && (place.isActive || place.deliveryRunId == null)) {
    return { ...from, salesOrderId };
  }
  const bay = await tx.stockLocation.findFirst({
    where: { storeLocationId: from.storeLocationId, locationType: "STAGING", isActive: true },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (!bay) {
    throw new UndoHandoverError(
      "The units left from a delivery run's truck, and this store has no loading bay to put them back in. Add one under Warehouse › Locations first.",
    );
  }
  return { storeLocationId: from.storeLocationId, stockLocationId: bay.id, salesOrderId };
}

/** Put the handover's units back on the books, committed to the order. */
async function returnUnits(
  tx: Tx,
  handoverId: number,
  salesOrderId: number,
  actor: string | null,
): Promise<number> {
  const moved = await tx.stockMovement.findMany({
    where: { orderHandoverId: handoverId, reason: "DELIVER" },
    orderBy: { id: "asc" },
    select: {
      productId: true,
      quantity: true,
      fromStoreLocationId: true,
      fromStockLocationId: true,
    },
  });
  await lockProducts(
    tx,
    moved.map((m) => m.productId),
  );
  let units = 0;
  for (const m of moved) {
    if (m.fromStoreLocationId == null || m.fromStockLocationId == null) continue;
    const quantity = Number(m.quantity);
    await postMovement(tx, {
      productId: m.productId,
      quantity,
      to: await placeBack(
        tx,
        { storeLocationId: m.fromStoreLocationId, stockLocationId: m.fromStockLocationId },
        salesOrderId,
      ),
      reason: "UNDELIVER",
      source: { type: "SalesOrder", id: salesOrderId },
      actor,
      orderHandoverId: handoverId,
    });
    units += quantity;
  }
  return units;
}

/** A delivery back in the dispatch pool: its stop off its run, its appointment pending. */
async function backToPool(
  tx: Tx,
  deliveryStopId: number | null,
  note: string,
  actor: string | null,
): Promise<void> {
  if (deliveryStopId == null) return;
  const stop = await tx.deliveryStop.findUnique({
    where: { id: deliveryStopId },
    select: { id: true, serviceAppointment: { select: { id: true, notes: true } } },
  });
  if (!stop) return;
  await tx.deliveryStop.delete({ where: { id: stop.id } });
  const appt = stop.serviceAppointment;
  await tx.serviceAppointment.update({
    where: { id: appt.id },
    data: {
      status: "PENDING",
      notes: appt.notes ? `${appt.notes}\n${note}` : note,
      updatedBy: actor,
    },
  });
}

export async function undoHandover(
  tx: Tx,
  input: { salesOrderId: number; reason: unknown; actor: string | null },
): Promise<UndoHandoverResult> {
  const reason = readReason(input.reason);
  const order = await tx.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: {
      id: true,
      orderDate: true,
      deliveredAt: true,
      salesPersonId: true,
      splitWithId: true,
      salesperson: true,
    },
  });
  if (!order) throw new UndoHandoverError("Order not found.", 404);
  const deliveredAt = order.deliveredAt;
  if (!deliveredAt) throw new UndoHandoverError("This order hasn't been handed over.");

  const handover = await tx.orderHandover.findFirst({
    where: { salesOrderId: order.id, undoneAt: null, at: deliveredAt },
    orderBy: { id: "desc" },
  });
  if (!handover) {
    throw new UndoHandoverError(
      "This handover was recorded before Holt kept what a handover moves, so it can't be undone. Correct the stock with a count.",
    );
  }
  const returned = await tx.return.count({
    where: { salesOrderId: order.id, status: { not: "CANCELLED" } },
  });
  if (returned > 0) {
    throw new UndoHandoverError(
      "Goods on this order are being returned, so its handover can't be undone.",
    );
  }
  await assertCommissionUnpaid(tx, { ...order, deliveredAt });

  const unitsBack = await returnUnits(tx, handover.id, order.id, input.actor);

  await tx.salesOrder.update({
    where: { id: order.id },
    data: {
      deliveredAt: null,
      status: "ORDER",
      dispatchStatus: handover.previousDispatchStatus ?? DISPATCH_BEFORE[handover.method] ?? null,
      updatedBy: input.actor,
    },
  });
  for (const line of handover.linesBefore as { lineItemId: number; fulfilledQty: number }[]) {
    await tx.orderLineItem.updateMany({
      where: { id: line.lineItemId, salesOrderId: order.id },
      data: { fulfilledQty: line.fulfilledQty },
    });
  }
  const what = `${handover.method} at ${handover.at.toISOString()}`;
  await backToPool(
    tx,
    handover.deliveryStopId,
    `Handover undone (${what}): ${reason}`,
    input.actor,
  );
  await tx.orderHandover.update({
    where: { id: handover.id },
    data: { undoneAt: new Date(), undoneBy: input.actor, undoReason: reason },
  });
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: order.id,
      changeType: "HANDOVER_UNDONE",
      previousValue: what,
      reason,
      changedBy: input.actor ?? "system",
    },
  });
  return { handoverId: handover.id, unitsBack };
}
