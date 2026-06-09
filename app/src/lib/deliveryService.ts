// /app/src/lib/deliveryService.ts

import { prisma } from "@/lib/prisma";
import type { DeliveryRunStatus, DeliveryStopStatus } from "@prisma/client";

const VALID_RUN_TRANSITIONS: Record<DeliveryRunStatus, DeliveryRunStatus[]> = {
  PLANNING: ["LOADED", "COMPLETED"],
  LOADED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
};

const VALID_STOP_TRANSITIONS: Record<DeliveryStopStatus, DeliveryStopStatus[]> = {
  PENDING: ["EN_ROUTE", "FAILED"],
  EN_ROUTE: ["ARRIVED", "FAILED"],
  ARRIVED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

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
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const prefix = `DR-${yy}${mm}${dd}-`;

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
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const prefix = `PL-${yy}${mm}${dd}-`;

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

// Return DELIVERY-type appointments not yet assigned to a run, grouped by zone
export async function getUnassignedDeliveries(date?: Date, tx?: any) {
  const db = tx || prisma;

  const where: any = {
    type: "DELIVERY" as const,
    deliveryStop: null,
  };

  if (date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    where.scheduledDate = { gte: dayStart, lte: dayEnd };
  }

  const appointments = await db.serviceAppointment.findMany({
    where,
    include: {
      customer: true,
      address: true,
      salesOrder: {
        include: {
          lineItems: true,
        },
      },
      deliveryZone: true,
    },
    orderBy: { scheduledDate: "asc" },
  });

  const grouped: Record<string, typeof appointments> = {};
  for (const appt of appointments) {
    const zoneName = appt.deliveryZone?.name ?? "Unzoned";
    if (!grouped[zoneName]) grouped[zoneName] = [];
    grouped[zoneName].push(appt);
  }

  return grouped;
}

// Build a pick list for all stops on a delivery run
export async function generatePickList(deliveryRunId: number, createdBy: string, tx?: any) {
  const db = tx || prisma;

  const run = await db.deliveryRun.findUnique({
    where: { id: deliveryRunId },
    include: {
      stops: {
        include: {
          serviceAppointment: {
            include: {
              salesOrder: {
                include: {
                  lineItems: {
                    where: { productId: { not: null } },
                    include: { product: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!run) {
    throw new Error(`DeliveryRun ${deliveryRunId} not found`);
  }

  const pickListNumber = await generatePickListNumber();

  const pickList = await db.pickList.create({
    data: {
      pickListNumber,
      deliveryRunId,
      status: "CREATED",
      createdBy,
    },
  });

  for (const stop of run.stops) {
    const lineItems = stop.serviceAppointment?.salesOrder?.lineItems ?? [];

    for (const li of lineItems) {
      if (!li.productId) continue;

      // Find the current inventory position for this product
      const position = await db.inventoryPosition.findFirst({
        where: {
          productId: li.productId,
          quantity: { gt: 0 },
        },
        orderBy: { quantity: "desc" },
      });

      await db.pickListItem.create({
        data: {
          pickListId: pickList.id,
          orderLineItemId: li.id,
          productId: li.productId,
          quantity: li.quantity ?? 1,
          fromStockLocationId: position?.stockLocationId ?? null,
          fromStoreLocationId: position?.storeLocationId ?? null,
        },
      });
    }
  }

  return db.pickList.findUnique({
    where: { id: pickList.id },
    include: {
      items: {
        include: {
          product: true,
          orderLineItem: true,
          fromStockLocation: true,
          fromStoreLocation: true,
        },
      },
    },
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
