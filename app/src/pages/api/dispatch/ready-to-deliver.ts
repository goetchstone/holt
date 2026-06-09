// /app/src/pages/api/dispatch/ready-to-deliver.ts
//
// Returns ORDER-status orders where all POs have been received (items are
// physically in the warehouse), grouped by delivery zone. Uses PO-based
// in-stock logic: an order is "ready" when it has no POs or every PO is
// RECEIVED_FULL / SHORT_CLOSED.
//
// the POS does not export deliveryMethod or dispatchStatus. Until conveyance
// data is available, all orders are treated as deliveries.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

interface ReadyOrder {
  id: number;
  orderno: string;
  orderDate: string;
  customerName: string;
  address: string;
  city: string;
  zipCode: string;
  lineItemCount: number;
  isScheduled: boolean;
  scheduledDate: string | null;
  daysSinceReceived: number;
  storeName: string | null;
}

interface ZoneGroup {
  zoneName: string;
  zoneId: number | null;
  orders: ReadyOrder[];
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
      const orders = await prisma.salesOrder.findMany({
        where: { status: "ORDER" },
        select: {
          id: true,
          orderno: true,
          orderDate: true,
          customer: {
            select: {
              firstName: true,
              lastName: true,
              addresses: {
                select: { address1: true, city: true, state: true, zip: true },
                take: 1,
              },
            },
          },
          deliveryAddress: { select: { address1: true, city: true, state: true, zip: true } },
          store: { select: { name: true } },
          lineItems: {
            where: { lineItemStatus: { not: "CANCELLED" } },
            select: { id: true },
          },
          purchaseOrders: {
            select: { id: true, status: true },
          },
          serviceAppointments: {
            where: { type: "DELIVERY" },
            select: {
              id: true,
              scheduledDate: true,
              status: true,
              deliveryStop: { select: { id: true } },
            },
            orderBy: { scheduledDate: "desc" as const },
            take: 1,
          },
        },
        orderBy: { orderDate: "asc" },
      });

      // Post-filter: keep only orders where all POs are received (in-stock)
      // and exclude orders already assigned to a delivery run
      const readyOrders = orders.filter((o) => {
        const isOnRun = o.serviceAppointments.some((sa) => sa.deliveryStop !== null);
        if (isOnRun) return false;

        const hasPOs = o.purchaseOrders.length > 0;
        return hasPOs
          ? o.purchaseOrders.every(
              (po) => po.status === "RECEIVED_FULL" || po.status === "SHORT_CLOSED",
            )
          : true;
      });

      // Batch-resolve delivery zones from ZIP codes (with customer address fallback)
      const rawZips = readyOrders
        .map((o) => {
          const addr = o.deliveryAddress ?? o.customer?.addresses?.[0] ?? null;
          return addr?.zip ?? null;
        })
        .filter((z): z is string => z !== null);
      const zip5Set = new Set(rawZips.map((z) => z.substring(0, 5)));
      const zipCodes = [...zip5Set];

      const zoneZips =
        zipCodes.length > 0
          ? await prisma.deliveryZoneZip.findMany({
              where: { zipCode: { in: zipCodes } },
              select: {
                zipCode: true,
                deliveryZone: { select: { id: true, name: true } },
              },
            })
          : [];

      const zipToZone = new Map<string, { id: number; name: string }>();
      for (const zz of zoneZips) {
        zipToZone.set(zz.zipCode, { id: zz.deliveryZone.id, name: zz.deliveryZone.name });
      }

      // Group orders by zone
      const now = new Date();
      const zoneMap = new Map<string, { zoneId: number | null; orders: ReadyOrder[] }>();
      let scheduled = 0;
      let unscheduled = 0;

      for (const order of readyOrders) {
        const addr = order.deliveryAddress ?? order.customer?.addresses?.[0] ?? null;
        const rawZip = addr?.zip ?? "";
        const zip = rawZip.substring(0, 5);
        const zone = zip ? (zipToZone.get(zip) ?? null) : null;
        const zoneName = zone?.name || "Unzoned";
        const zoneId = zone?.id || null;

        const deliveryAppt = order.serviceAppointments[0] || null;
        const isScheduled = !!deliveryAppt?.scheduledDate;
        if (isScheduled) {
          scheduled++;
        } else {
          unscheduled++;
        }

        const customerFirst = order.customer?.firstName || "";
        const customerLast = order.customer?.lastName || "";
        const customerName = `${customerFirst} ${customerLast}`.trim() || "Unknown";

        const orderDateMs = order.orderDate ? new Date(order.orderDate).getTime() : now.getTime();
        const daysSinceReceived = Math.max(
          0,
          Math.floor((now.getTime() - orderDateMs) / (1000 * 60 * 60 * 24)),
        );

        const readyOrder: ReadyOrder = {
          id: order.id,
          orderno: order.orderno,
          orderDate: order.orderDate ? order.orderDate.toISOString().split("T")[0] : "",
          customerName,
          address: addr?.address1 || "",
          city: addr?.city || "",
          zipCode: zip,
          lineItemCount: order.lineItems.length,
          isScheduled,
          scheduledDate: deliveryAppt?.scheduledDate
            ? deliveryAppt.scheduledDate.toISOString().split("T")[0]
            : null,
          daysSinceReceived,
          storeName: order.store?.name || null,
        };

        if (!zoneMap.has(zoneName)) {
          zoneMap.set(zoneName, { zoneId, orders: [] });
        }
        zoneMap.get(zoneName)!.orders.push(readyOrder);
      }

      // Sort zones alphabetically, push "Unzoned" to the end
      const zones: ZoneGroup[] = Array.from(zoneMap.entries())
        .sort(([a], [b]) => {
          if (a === "Unzoned") return 1;
          if (b === "Unzoned") return -1;
          return a.localeCompare(b);
        })
        .map(([zoneName, data]) => ({
          zoneName,
          zoneId: data.zoneId,
          orders: data.orders,
        }));

      return res.status(200).json({
        summary: {
          total: readyOrders.length,
          scheduled,
          unscheduled,
          zones: zoneMap.size,
        },
        zones,
      });
    } catch (err: unknown) {
      logError("Failed to fetch ready-to-deliver orders", err);
      return res.status(500).json({ error: "Failed to fetch ready-to-deliver orders" });
    }
  },
);
