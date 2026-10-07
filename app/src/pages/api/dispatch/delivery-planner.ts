// /app/src/pages/api/dispatch/delivery-planner.ts
//
// Returns inbound POs (not yet fully received) linked to sales orders, grouped
// by delivery zone with week sub-grouping. Includes customer context (other
// in-stock and inbound orders) and pencil-in status.
//
// the POS does not export deliveryMethod. Until conveyance data is available,
// all orders are treated as deliveries.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { startOfWeek, endOfWeek, addWeeks, format } from "date-fns";

type WeekFilter = "all" | "thisWeek" | "nextWeek" | "later" | "noEsd";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
      const where: Prisma.PurchaseOrderWhereInput = {
        status: { in: ["SUBMITTED", "CONFIRMED", "RECEIVED_PARTIAL"] },
        isReturn: { not: true },
        salesOrderId: { not: null },
      };

      const purchaseOrders = await prisma.purchaseOrder.findMany({
        where,
        select: {
          id: true,
          poNumber: true,
          expectedDelivery: true,
          status: true,
          vendor: { select: { name: true } },
          salesOrder: {
            select: {
              id: true,
              orderno: true,
              customerId: true,
              customer: {
                select: {
                  firstName: true,
                  lastName: true,
                  addresses: {
                    select: { city: true, zip: true },
                    take: 1,
                  },
                },
              },
              deliveryAddress: { select: { city: true, zip: true } },
            },
          },
          _count: { select: { lineItems: true } },
        },
        orderBy: { expectedDelivery: { sort: "asc", nulls: "last" } },
      });

      // Resolve ZIP zones
      const allZips = purchaseOrders
        .map((po) => {
          const addr =
            po.salesOrder?.deliveryAddress ?? po.salesOrder?.customer?.addresses?.[0] ?? null;
          return addr?.zip ?? null;
        })
        .filter((z): z is string => z !== null);

      const uniqueZips = [...new Set(allZips.map((z) => z.substring(0, 5)))];

      const zipMappings =
        uniqueZips.length > 0
          ? await prisma.deliveryZoneZip.findMany({
              where: { zipCode: { in: uniqueZips } },
              select: { zipCode: true, deliveryZone: { select: { id: true, name: true } } },
            })
          : [];

      const zipToZone = new Map(
        zipMappings.map((m) => [m.zipCode, { id: m.deliveryZone.id, name: m.deliveryZone.name }]),
      );

      // Collect unique customer IDs for context lookup
      const customerIds = new Set<number>();
      for (const po of purchaseOrders) {
        if (po.salesOrder?.customerId) customerIds.add(po.salesOrder.customerId);
      }

      // Batch-query customer context: other ORDER-status orders with PO info
      const customerOrders =
        customerIds.size > 0
          ? await prisma.salesOrder.findMany({
              where: {
                customerId: { in: [...customerIds] },
                status: "ORDER",
              },
              select: {
                id: true,
                customerId: true,
                purchaseOrders: {
                  select: { status: true },
                },
                serviceAppointments: {
                  where: { type: "DELIVERY", deliveryStop: { isNot: null } },
                  select: {
                    scheduledDate: true,
                    deliveryStop: {
                      select: {
                        deliveryRun: { select: { status: true } },
                      },
                    },
                  },
                  take: 1,
                },
              },
            })
          : [];

      // Build customer context map: { customerId -> { inStockCount, inboundCount } }
      const customerContext = new Map<number, { inStockCount: number; inboundCount: number }>();

      for (const o of customerOrders) {
        if (!o.customerId) continue;
        if (!customerContext.has(o.customerId)) {
          customerContext.set(o.customerId, { inStockCount: 0, inboundCount: 0 });
        }
        const ctx = customerContext.get(o.customerId)!;
        const hasPOs = o.purchaseOrders.length > 0;
        const allReceived = hasPOs
          ? o.purchaseOrders.every(
              (po) => po.status === "RECEIVED_FULL" || po.status === "SHORT_CLOSED",
            )
          : true;

        if (allReceived) {
          ctx.inStockCount++;
        } else {
          ctx.inboundCount++;
        }
      }

      // Build planned-date map: salesOrderId -> planned date (if on a PLANNING run)
      const plannedMap = new Map<number, string>();
      for (const o of customerOrders) {
        const appt = o.serviceAppointments[0];
        if (appt?.deliveryStop?.deliveryRun?.status === "PLANNING" && appt.scheduledDate) {
          plannedMap.set(o.id, appt.scheduledDate.toISOString());
        }
      }

      // Compute week boundaries
      const now = new Date();
      const weekStart = startOfWeek(now, { weekStartsOn: 1 });
      const thisWeekEnd = endOfWeek(now, { weekStartsOn: 1 });
      const nextWeekEnd = endOfWeek(addWeeks(weekStart, 1), { weekStartsOn: 1 });
      const laterEnd = endOfWeek(addWeeks(weekStart, 4), { weekStartsOn: 1 });

      let dueThisWeek = 0;
      let dueNextWeek = 0;
      let dueLater = 0;
      let noEsd = 0;

      type OrderRow = {
        poId: number;
        poNumber: string;
        vendorName: string;
        expectedDelivery: string | null;
        status: string;
        customerName: string;
        customerId: number | null;
        city: string;
        zipCode: string;
        salesOrderId: number;
        orderno: string;
        lineItemCount: number;
        weekLabel: string;
        weekStart: string | null;
        weekFilter: WeekFilter;
        inStockCount: number;
        inboundCount: number;
        plannedDate: string | null;
      };

      const zoneMap = new Map<string, { zoneId: number | null; orders: OrderRow[] }>();

      for (const po of purchaseOrders) {
        const addr =
          po.salesOrder?.deliveryAddress ?? po.salesOrder?.customer?.addresses?.[0] ?? null;
        const rawZip = addr?.zip ?? "";
        const zip = rawZip.substring(0, 5);
        const zone = zip ? (zipToZone.get(zip) ?? null) : null;
        const zoneName = zone?.name || "Unzoned";
        const zoneId = zone?.id ?? null;

        const esd = po.expectedDelivery;
        let weekLabel = "No ESD";
        let weekStartIso: string | null = null;
        let weekFilter: WeekFilter = "noEsd";

        if (esd) {
          const esdDate = new Date(esd);
          const esdWeekStart = startOfWeek(esdDate, { weekStartsOn: 1 });
          weekLabel = `Week of ${format(esdWeekStart, "MMM d")}`;
          weekStartIso = esdWeekStart.toISOString();

          if (esdDate >= weekStart && esdDate <= thisWeekEnd) {
            dueThisWeek++;
            weekFilter = "thisWeek";
          } else if (esdDate > thisWeekEnd && esdDate <= nextWeekEnd) {
            dueNextWeek++;
            weekFilter = "nextWeek";
          } else if (esdDate > nextWeekEnd && esdDate <= laterEnd) {
            dueLater++;
            weekFilter = "later";
          } else {
            weekFilter = "all";
          }
        } else {
          noEsd++;
        }

        const customer = po.salesOrder?.customer;
        const customerName =
          [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() || "Unknown";
        const customerId = po.salesOrder?.customerId ?? null;

        // Customer context — subtract 1 from inbound since this PO's order is counted there
        const ctx = customerId ? customerContext.get(customerId) : null;
        let inStockCount = ctx?.inStockCount ?? 0;
        let inboundCount = ctx?.inboundCount ?? 0;
        // The current PO's sales order is in the inbound count; don't double-show it
        if (inboundCount > 0) inboundCount = Math.max(0, inboundCount - 1);

        const row: OrderRow = {
          poId: po.id,
          poNumber: po.poNumber,
          vendorName: po.vendor.name,
          expectedDelivery: esd ? esd.toISOString() : null,
          status: po.status,
          customerName,
          customerId,
          city: addr?.city || "",
          zipCode: zip,
          salesOrderId: po.salesOrder!.id,
          orderno: po.salesOrder!.orderno,
          lineItemCount: po._count.lineItems,
          weekLabel,
          weekStart: weekStartIso,
          weekFilter,
          inStockCount,
          inboundCount,
          plannedDate: plannedMap.get(po.salesOrder!.id) ?? null,
        };

        if (!zoneMap.has(zoneName)) {
          zoneMap.set(zoneName, { zoneId, orders: [] });
        }
        zoneMap.get(zoneName)!.orders.push(row);
      }

      const zones = Array.from(zoneMap.entries())
        .sort(([a], [b]) => {
          if (a === "Unzoned") return 1;
          if (b === "Unzoned") return -1;
          return a.localeCompare(b);
        })
        .map(([zoneName, { zoneId, orders }]) => ({ zoneName, zoneId, orders }));

      return res.status(200).json({
        summary: {
          total: purchaseOrders.length,
          dueThisWeek,
          dueNextWeek,
          dueLater,
          noEsd,
        },
        zones,
      });
    } catch (err: unknown) {
      logError("Failed to build delivery planner data", err);
      return res.status(500).json({ error: "Failed to load delivery planner" });
    }
  },
);
