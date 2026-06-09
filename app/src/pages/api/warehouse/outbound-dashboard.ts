// /app/src/pages/api/warehouse/outbound-dashboard.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

interface DeliveryItem {
  id: number;
  scheduledDate: string | null;
  scheduledTime: string | null;
  status: string;
  customerName: string;
  orderNumber: string;
  salesOrderId: number;
  zoneName: string | null;
}

interface NeedsSchedulingItem {
  id: number;
  orderno: string;
  customerName: string;
  orderDate: string | null;
  lineItemCount: number;
  daysSinceReceived: number;
}

interface TransferItem {
  id: number;
  fromLocation: string;
  toLocation: string;
  itemCount: number;
  status: string;
  shippedAt: string | null;
}

interface DashboardResponse {
  summary: {
    upcomingDeliveries: number;
    needsScheduling: number;
    activeTransfers: number;
  };
  deliveries: DeliveryItem[];
  needsScheduling: NeedsSchedulingItem[];
  transfers: TransferItem[];
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const appointmentWhere: Prisma.ServiceAppointmentWhereInput = {
        type: "DELIVERY",
        status: { in: ["PENDING", "SCHEDULED", "CONFIRMED", "IN_PROGRESS"] },
      };

      const [appointments, schedulingOrders, transfers] = await Promise.all([
        prisma.serviceAppointment.findMany({
          where: appointmentWhere,
          orderBy: { scheduledDate: "asc" },
          include: {
            salesOrder: {
              select: {
                id: true,
                orderno: true,
                customer: { select: { firstName: true, lastName: true } },
              },
            },
            deliveryZone: { select: { name: true } },
          },
        }),

        prisma.salesOrder.findMany({
          where: {
            dispatchStatus: "RECEIVED_IN_WAREHOUSE",
            deliveryMethod: "DELIVERY",
            serviceAppointments: {
              none: { type: "DELIVERY" },
            },
          },
          orderBy: { orderDate: "asc" },
          include: {
            customer: { select: { firstName: true, lastName: true } },
            lineItems: { select: { id: true } },
          },
        }),

        prisma.inventoryTransfer.findMany({
          where: { status: { in: ["DRAFT", "IN_TRANSIT"] } },
          orderBy: { created: "desc" },
          include: {
            fromStoreLocation: { select: { name: true } },
            toStoreLocation: { select: { name: true } },
          },
        }),
      ]);

      const now = new Date();

      const deliveries: DeliveryItem[] = appointments.map((appt) => {
        const cust = appt.salesOrder.customer;
        const customerName = cust
          ? [cust.firstName, cust.lastName].filter(Boolean).join(" ") || "Unknown"
          : "Unknown";

        return {
          id: appt.id,
          scheduledDate: appt.scheduledDate ? appt.scheduledDate.toISOString() : null,
          scheduledTime: appt.scheduledTime || null,
          status: appt.status,
          customerName,
          orderNumber: appt.salesOrder.orderno,
          salesOrderId: appt.salesOrder.id,
          zoneName: appt.deliveryZone?.name || null,
        };
      });

      const needsScheduling: NeedsSchedulingItem[] = schedulingOrders.map((order) => {
        const cust = order.customer;
        const customerName = cust
          ? [cust.firstName, cust.lastName].filter(Boolean).join(" ") || "Unknown"
          : "Unknown";

        const orderDateMs = order.updated?.getTime() || order.created.getTime();
        const daysSinceReceived = Math.floor((now.getTime() - orderDateMs) / (1000 * 60 * 60 * 24));

        return {
          id: order.id,
          orderno: order.orderno,
          customerName,
          orderDate: order.orderDate ? order.orderDate.toISOString() : null,
          lineItemCount: order.lineItems.length,
          daysSinceReceived: Math.max(0, daysSinceReceived),
        };
      });

      const transferItems: TransferItem[] = transfers.map((t) => ({
        id: t.id,
        fromLocation: t.fromStoreLocation?.name || t.fromLocation,
        toLocation: t.toStoreLocation?.name || t.toLocation,
        itemCount: t.quantity,
        status: t.status,
        shippedAt: t.shippedAt ? t.shippedAt.toISOString() : null,
      }));

      const response: DashboardResponse = {
        summary: {
          upcomingDeliveries: deliveries.length,
          needsScheduling: needsScheduling.length,
          activeTransfers: transferItems.length,
        },
        deliveries,
        needsScheduling,
        transfers: transferItems,
      };

      return res.status(200).json(response);
    } catch (err: unknown) {
      logError("Failed to fetch outbound dashboard data", err);
      return res.status(500).json({ error: "Failed to fetch outbound dashboard" });
    }
  },
);
