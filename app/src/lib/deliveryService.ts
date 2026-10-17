// /app/src/lib/deliveryService.ts

import { getBusinessTimeZone } from "@/lib/appSettings";
import { businessDayStamp } from "@/lib/reports/businessDay";
import { prisma } from "@/lib/prisma";
import { toQty } from "@/lib/inventory/quantity";
import { buildPullList } from "@/lib/fulfilment/pullList";
import type { DeliveryRunStatus, DeliveryStopStatus, Prisma } from "@prisma/client";

const VALID_RUN_TRANSITIONS: Record<DeliveryRunStatus, DeliveryRunStatus[]> = {
  PLANNING: ["LOADED", "COMPLETED"],
  LOADED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
};

// A stop that could not be delivered goes BACK to PENDING and is rescheduled --
// it is not a terminal failure. The truck going out and coming back is not an
// outcome, it is an attempt; the delivery simply has not happened yet, nothing
// was recognised, and there is nothing to reverse. (Goods that were delivered
// and then sent back are a Return with a pickup -- lib/returnService.ts.)
//
// COMPLETED is terminal because handing the goods over is not undoable: it sets
// SalesOrder.deliveredAt, which recognises the sale.
//
// PENDING -> ARRIVED directly: nothing sets EN_ROUTE (the driver screen has no
// such step), so with only PENDING -> EN_ROUTE allowed, the driver's "Mark
// Arrived" was refused and no stop could be completed (found 2026-10-16).
// Arriving is what COMPLETED needs; en route is optional.
const VALID_STOP_TRANSITIONS: Record<DeliveryStopStatus, DeliveryStopStatus[]> = {
  PENDING: ["EN_ROUTE", "ARRIVED"],
  EN_ROUTE: ["ARRIVED", "PENDING"],
  ARRIVED: ["COMPLETED", "PENDING"],
  COMPLETED: [],
};

/**
 * The dispatch pool: DELIVERY appointments not on a run, still to do. IN_PROGRESS
 * is in it: a stop that could not be done comes off its run
 * (lib/fulfilment/stops.ts failStop) whatever its appointment's status, and an
 * appointment with no stop is on no truck. Left out, it vanished from dispatch.
 */
export const UNASSIGNED_DELIVERY_WHERE = {
  type: "DELIVERY",
  deliveryStop: null,
  status: { in: ["PENDING", "SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
} satisfies Prisma.ServiceAppointmentWhereInput;

export function isValidRunTransition(from: DeliveryRunStatus, to: DeliveryRunStatus): boolean {
  return VALID_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isValidStopTransition(from: DeliveryStopStatus, to: DeliveryStopStatus): boolean {
  return VALID_STOP_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidRunTransitions(from: DeliveryRunStatus): DeliveryRunStatus[] {
  return VALID_RUN_TRANSITIONS[from] ?? [];
}

export function getValidStopTransitions(from: DeliveryStopStatus): DeliveryStopStatus[] {
  return VALID_STOP_TRANSITIONS[from] ?? [];
}

// Generate run number: DR-YYMMDD-NNN
export async function generateRunNumber(): Promise<string> {
  const now = new Date();
  const stamp = businessDayStamp(now, await getBusinessTimeZone());
  const prefix = `DR-${stamp}-`;

  const last = await prisma.deliveryRun.findFirst({
    where: { runNumber: { startsWith: prefix } },
    orderBy: { runNumber: "desc" },
    select: { runNumber: true },
  });

  let seq = 1;
  if (last) {
    const lastSeq = Number.parseInt(last.runNumber.replace(prefix, ""), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${seq.toString().padStart(3, "0")}`;
}

// Generate pick list number: PL-YYMMDD-NNN
export async function generatePickListNumber(): Promise<string> {
  const now = new Date();
  const stamp = businessDayStamp(now, await getBusinessTimeZone());
  const prefix = `PL-${stamp}-`;

  const last = await prisma.pickList.findFirst({
    where: { pickListNumber: { startsWith: prefix } },
    orderBy: { pickListNumber: "desc" },
    select: { pickListNumber: true },
  });

  let seq = 1;
  if (last) {
    const lastSeq = Number.parseInt(last.pickListNumber.replace(prefix, ""), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${seq.toString().padStart(3, "0")}`;
}

// Look up a ZIP code to find its delivery zone
export async function resolveDeliveryZone(zipCode: string, tx?: any) {
  const db = tx || prisma;

  const match = await db.deliveryZoneZip.findFirst({
    where: { zipCode },
    include: { deliveryZone: true },
  });

  return match?.deliveryZone ?? null;
}

/**
 * What a pick-list response carries, for GET and for the POST that creates one:
 * the names and numbers a picker works from. Never whole product or order-line
 * rows, which hold what the store paid.
 */
export const PICK_LIST_DETAIL_INCLUDE = {
  assignedTo: { select: { id: true, displayName: true } },
  items: {
    include: {
      product: { select: { id: true, name: true, productNumber: true } },
      orderLineItem: { select: { id: true, productName: true } },
      fromStockLocation: { select: { id: true, name: true } },
      fromStoreLocation: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PickListInclude;

/**
 * A pick list on its way to a screen. A line's quantity is Decimal, because a
 * line can be a part roll, and JSON would send a Decimal as a string.
 */
export function pickListForClient<T extends { items: { quantity: Prisma.Decimal }[] }>(
  pickList: T,
) {
  return {
    ...pickList,
    items: pickList.items.map((item) => ({ ...item, quantity: toQty(item.quantity) })),
  };
}

/**
 * Write a pick list from the pull list (lib/fulfilment/pullList.ts): for a
 * delivery run, every order on its stops; for one order, that order. Each item
 * is the order's own committed stock at the place it sits, or -- for what the
 * order holds none of -- a line with no place, so the gap shows on the list.
 */
export async function generatePickList(
  scope: { deliveryRunId: number } | { salesOrderId: number },
  createdBy: string,
  tx?: Prisma.TransactionClient,
) {
  const db: Prisma.TransactionClient = tx ?? prisma;

  if ("deliveryRunId" in scope) {
    const run = await db.deliveryRun.findUnique({ where: { id: scope.deliveryRunId } });
    if (!run) throw new Error(`DeliveryRun ${scope.deliveryRunId} not found`);
  }

  const { rows } = await buildPullList(db, scope);
  const pickList = await db.pickList.create({
    data: {
      pickListNumber: await generatePickListNumber(),
      ...scope,
      status: "CREATED",
      createdBy,
    },
  });
  if (rows.length > 0) {
    await db.pickListItem.createMany({
      data: rows.map((row) => ({
        pickListId: pickList.id,
        orderLineItemId: row.orderLineItemId,
        productId: row.productId,
        quantity: row.quantity,
        fromStockLocationId: row.fromStockLocationId,
        fromStoreLocationId: row.fromStoreLocationId,
        notes: row.crossSite ? "At another store: transfer it before pulling" : null,
      })),
    });
  }

  return db.pickList.findUniqueOrThrow({
    where: { id: pickList.id },
    include: PICK_LIST_DETAIL_INCLUDE,
  });
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Assign a sales order to a delivery run. Creates a ServiceAppointment
 * (DELIVERY, SCHEDULED) and a DeliveryStop (PENDING) in one step.
 * Used by both the dispatch board drag-and-drop and the planner pencil-in.
 */
export async function assignOrderToRun(
  tx: TxClient,
  opts: {
    salesOrderId: number;
    runId: number;
    runDate: Date;
    createdBy: string | null;
  },
): Promise<{ stopId: number; appointmentId: number; stopOrder: number }> {
  const order = await tx.salesOrder.findUnique({
    where: { id: opts.salesOrderId },
    select: {
      id: true,
      orderno: true,
      customerId: true,
      deliveryAddressId: true,
      customer: {
        select: { addresses: { select: { zip: true }, take: 1 } },
      },
    },
  });
  if (!order) throw new Error("Order not found");

  // Check if order already has a DELIVERY appointment on a run
  const existing = await tx.serviceAppointment.findFirst({
    where: {
      salesOrderId: opts.salesOrderId,
      type: "DELIVERY",
      deliveryStop: { isNot: null },
    },
    select: { id: true },
  });
  if (existing) throw new Error("Order is already assigned to a run");

  // Resolve delivery zone from address (with customer fallback)
  let deliveryZoneId: number | null = null;
  let zip: string | null = null;

  if (order.deliveryAddressId) {
    const addr = await tx.customerAddress.findUnique({
      where: { id: order.deliveryAddressId },
      select: { zip: true },
    });
    zip = addr?.zip ?? null;
  }
  if (!zip) {
    zip = order.customer?.addresses?.[0]?.zip ?? null;
  }

  if (zip) {
    const zip5 = zip.substring(0, 5);
    const zoneZip = await tx.deliveryZoneZip.findFirst({
      where: { zipCode: zip5 },
      select: { deliveryZoneId: true },
    });
    if (zoneZip) deliveryZoneId = zoneZip.deliveryZoneId;
  }

  // Generate appointment number
  const dateStr = opts.runDate.toISOString().slice(0, 10).replace(/-/g, "");
  const count = await tx.serviceAppointment.count({ where: { type: "DELIVERY" } });
  const appointmentNumber = `DEL-${dateStr}-${String(count + 1).padStart(3, "0")}`;

  const appointment = await tx.serviceAppointment.create({
    data: {
      appointmentNumber,
      type: "DELIVERY",
      status: "SCHEDULED",
      salesOrderId: opts.salesOrderId,
      customerId: order.customerId,
      scheduledDate: opts.runDate,
      deliveryZoneId,
      createdBy: opts.createdBy,
    },
  });

  const lastStop = await tx.deliveryStop.findFirst({
    where: { deliveryRunId: opts.runId },
    orderBy: { stopOrder: "desc" },
    select: { stopOrder: true },
  });
  const nextOrder = (lastStop?.stopOrder ?? 0) + 1;

  const stop = await tx.deliveryStop.create({
    data: {
      deliveryRunId: opts.runId,
      serviceAppointmentId: appointment.id,
      stopOrder: nextOrder,
      status: "PENDING",
    },
  });

  return { stopId: stop.id, appointmentId: appointment.id, stopOrder: nextOrder };
}

/**
 * Find or create a PLANNING delivery run for a given date.
 * Used by pencil-in to auto-create runs as needed.
 */
export async function findOrCreatePlanningRun(
  tx: TxClient,
  date: Date,
  createdBy: string | null,
): Promise<{ id: number; runDate: Date }> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const existing = await tx.deliveryRun.findFirst({
    where: {
      runDate: { gte: dayStart, lte: dayEnd },
      status: "PLANNING",
    },
    select: { id: true, runDate: true },
  });
  if (existing) return existing;

  // Need a vehicle — pick the first active one
  const vehicle = await tx.vehicle.findFirst({
    where: { isActive: true },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (!vehicle) throw new Error("No active vehicles available");

  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const datePrefix = `DR-${yy}${mm}${dd}`;
  const existingCount = await tx.deliveryRun.count({
    where: { runNumber: { startsWith: datePrefix } },
  });
  const runNumber = `${datePrefix}-${existingCount + 1}`;

  const run = await tx.deliveryRun.create({
    data: {
      runNumber,
      runDate: date,
      vehicleId: vehicle.id,
      status: "PLANNING",
      createdBy,
    },
    select: { id: true, runDate: true },
  });

  return run;
}
