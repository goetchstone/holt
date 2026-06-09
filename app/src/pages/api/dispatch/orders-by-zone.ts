// /app/src/pages/api/dispatch/orders-by-zone.ts
//
// Returns unfulfilled orders grouped by customer within delivery zones.
// Multiple orders for the same customer are grouped together since they
// go to the same address in one delivery.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { computeBalance } from "@/lib/paymentService";

export interface DispatchLineItem {
  id: number;
  partNo: string | null;
  productName: string | null;
  orderedQuantity: number;
  status: string | null;
}

export interface DispatchOrderPO {
  id: number;
  poNumber: string;
  status: string;
  expectedDelivery: string | null;
}

export interface DispatchOrder {
  id: number;
  orderno: string;
  orderDate: string;
  lineItemCount: number;
  inStock: boolean;
  lineItems: DispatchLineItem[];
  purchaseOrders: DispatchOrderPO[];
  balanceDue: number;
}

export interface DispatchCustomer {
  customerId: number | null;
  customerName: string;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  zoneName: string | null;
  zoneId: number | null;
  orders: DispatchOrder[];
  totalItems: number;
  allInStock: boolean;
  totalBalanceDue: number;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const orders = await prisma.salesOrder.findMany({
        where: { status: "ORDER" },
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              addresses: {
                select: { address1: true, city: true, state: true, zip: true },
                take: 1,
              },
            },
          },
          deliveryAddress: { select: { address1: true, city: true, state: true, zip: true } },
          lineItems: {
            select: {
              id: true,
              partNo: true,
              productName: true,
              orderedQuantity: true,
              netPrice: true,
              vatAmount: true,
              lineItemStatus: true,
            },
            where: { lineItemStatus: { not: "CANCELLED" } },
          },
          purchaseOrders: {
            select: { id: true, poNumber: true, status: true, expectedDelivery: true },
          },
          payments: {
            select: { paymentAmount: true, status: true, isRefund: true },
          },
          serviceAppointments: {
            where: { type: "DELIVERY", deliveryStop: { isNot: null } },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: { orderDate: "asc" },
      });

      // Batch-resolve delivery zones from ZIP codes
      const rawZips = orders
        .map((o) => o.deliveryAddress?.zip ?? o.customer?.addresses?.[0]?.zip)
        .filter((z): z is string => z !== null && z !== undefined);
      const zip5Set = new Set(rawZips.map((z) => z.substring(0, 5)));
      const zipCodes = [...zip5Set];

      const zoneZips =
        zipCodes.length > 0
          ? await prisma.deliveryZoneZip.findMany({
              where: { zipCode: { in: zipCodes } },
              include: { deliveryZone: { select: { id: true, name: true } } },
            })
          : [];

      const zipToZone = new Map<string, { id: number; name: string }>();
      for (const zz of zoneZips) {
        zipToZone.set(zz.zipCode, { id: zz.deliveryZone.id, name: zz.deliveryZone.name });
      }

      // Group orders by customer
      const customerMap = new Map<string, DispatchCustomer>();

      for (const o of orders) {
        const isOnRun = o.serviceAppointments.length > 0;
        if (isOnRun) continue;

        const custFirst = o.customer?.firstName ?? "";
        const custLast = o.customer?.lastName ?? "";
        const customerName = `${custFirst} ${custLast}`.trim() || o.salesperson || "Unknown";
        const customerId = o.customer?.id ?? null;
        const addr = o.deliveryAddress ?? o.customer?.addresses?.[0] ?? null;
        const rawZip = addr?.zip ?? null;
        const zip = rawZip?.substring(0, 5) ?? null;
        const zone = zip ? (zipToZone.get(zip) ?? null) : null;

        // Group key: customerId or fallback to customer name + zip
        const groupKey = customerId ? `cust-${customerId}` : `name-${customerName}-${zip}`;

        const hasPOs = o.purchaseOrders.length > 0;
        const allReceived = hasPOs
          ? o.purchaseOrders.every(
              (po) => po.status === "RECEIVED_FULL" || po.status === "SHORT_CLOSED",
            )
          : true;

        const balance = computeBalance(o.lineItems, o.payments);

        const order: DispatchOrder = {
          id: o.id,
          orderno: o.orderno,
          orderDate: o.orderDate?.toISOString() ?? "",
          lineItemCount: o.lineItems.length,
          inStock: allReceived,
          lineItems: o.lineItems.map((li) => ({
            id: li.id,
            partNo: li.partNo,
            productName: li.productName,
            orderedQuantity: Number(li.orderedQuantity),
            status: li.lineItemStatus,
          })),
          purchaseOrders: o.purchaseOrders.map((po) => ({
            id: po.id,
            poNumber: po.poNumber,
            status: po.status,
            expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
          })),
          balanceDue: balance.balanceDue,
        };

        if (customerMap.has(groupKey)) {
          const existing = customerMap.get(groupKey)!;
          existing.orders.push(order);
          existing.totalItems += o.lineItems.length;
          existing.totalBalanceDue += balance.balanceDue;
          if (!allReceived) existing.allInStock = false;
        } else {
          customerMap.set(groupKey, {
            customerId,
            customerName,
            address: addr?.address1 ?? null,
            city: addr?.city ?? null,
            zipCode: zip,
            zoneName: zone?.name ?? null,
            zoneId: zone?.id ?? null,
            orders: [order],
            totalItems: o.lineItems.length,
            allInStock: allReceived,
            totalBalanceDue: balance.balanceDue,
          });
        }
      }

      // Group customers by zone
      const zoneMap = new Map<string, DispatchCustomer[]>();
      const unzoned: DispatchCustomer[] = [];

      for (const customer of customerMap.values()) {
        if (customer.zoneName) {
          if (!zoneMap.has(customer.zoneName)) zoneMap.set(customer.zoneName, []);
          zoneMap.get(customer.zoneName)!.push(customer);
        } else {
          unzoned.push(customer);
        }
      }

      const zones = [...zoneMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([zoneName, customers]) => ({ zoneName, customers }));

      const allCustomers = [...zones.flatMap((z) => z.customers), ...unzoned];
      const inStockCount = allCustomers.filter((c) => c.allInStock).length;

      return res.json({
        zones,
        unzoned,
        total: allCustomers.length,
        inStockCount,
        totalOrders: allCustomers.reduce((s, c) => s + c.orders.length, 0),
      });
    } catch (err: unknown) {
      logError("Failed to fetch dispatch orders by zone", err);
      return res.status(500).json({ error: "Failed to fetch dispatch orders" });
    }
  },
);
