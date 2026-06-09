// /app/src/lib/serviceDispatchService.ts

import { prisma } from "@/lib/prisma";
import type { ServiceAppointmentStatus, ServiceAppointmentType } from "@prisma/client";

const VALID_TRANSITIONS: Record<ServiceAppointmentStatus, ServiceAppointmentStatus[]> = {
  PENDING: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["CONFIRMED", "IN_PROGRESS", "CANCELLED"],
  CONFIRMED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function isValidTransition(
  from: ServiceAppointmentStatus,
  to: ServiceAppointmentStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidTransitions(from: ServiceAppointmentStatus): ServiceAppointmentStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}

const TERMINAL_STATES: Set<ServiceAppointmentStatus> = new Set(["COMPLETED", "CANCELLED"]);

export function isTerminalState(status: ServiceAppointmentStatus): boolean {
  return TERMINAL_STATES.has(status);
}

// Generate appointment number: SVC-YYMMDD-NNN
export async function generateAppointmentNumber(): Promise<string> {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const prefix = `SVC-${yy}${mm}${dd}-`;

  const last = await prisma.serviceAppointment.findFirst({
    where: { appointmentNumber: { startsWith: prefix } },
    orderBy: { appointmentNumber: "desc" },
    select: { appointmentNumber: true },
  });

  let seq = 1;
  if (last) {
    const lastSeq = Number.parseInt(last.appointmentNumber.replace(prefix, ""), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${seq.toString().padStart(3, "0")}`;
}

// Sync service appointments for an order -- creates PENDING appointments for
// service line items that don't have one, cancels appointments for cancelled line items
export async function syncServiceAppointments(salesOrderId: number, tx?: any): Promise<void> {
  const db = tx || prisma;

  const lineItems = await db.orderLineItem.findMany({
    where: { salesOrderId },
    include: {
      product: { select: { serviceType: true } },
      serviceAppointments: { select: { id: true, status: true } },
    },
  });

  for (const li of lineItems) {
    const serviceType: ServiceAppointmentType | null = li.product?.serviceType ?? null;

    if (li.lineItemStatus === "CANCELLED") {
      // Cancel any non-terminal appointments for cancelled line items
      const activeAppointments = li.serviceAppointments.filter(
        (a: { status: ServiceAppointmentStatus }) => !isTerminalState(a.status),
      );
      for (const appt of activeAppointments) {
        await db.serviceAppointment.update({
          where: { id: appt.id },
          data: { status: "CANCELLED" },
        });
      }
      continue;
    }

    // For active line items with a service type, create appointment if none exists
    if (serviceType && li.serviceAppointments.length === 0) {
      const appointmentNumber = await generateAppointmentNumber();
      await db.serviceAppointment.create({
        data: {
          appointmentNumber,
          type: serviceType,
          status: "PENDING",
          salesOrderId,
          lineItemId: li.id,
        },
      });
    }
  }
}
