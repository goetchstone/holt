// /app/src/pages/api/warehouse/awaiting-delivery.ts
//
// Returns orders with status ORDER and no invoice — these have not been
// delivered/fulfilled. Grouped by age: This Month, Last 30 Days, 1-3 Months,
// 3-6 Months, 6-12 Months, Over 1 Year.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { computeBalance } from "@/lib/paymentService";

interface LinkedPO {
  id: number;
  poNumber: string;
  status: string;
  expectedDelivery: string | null;
}

interface LineItemSummary {
  id: number;
  productName: string | null;
  partNo: string | null;
  orderedQuantity: number;
  netPrice: number;
  lineItemStatus: string | null;
}

export interface AwaitingDeliveryOrder {
  id: number;
  orderno: string;
  orderDate: string;
  customerName: string;
  storeName: string | null;
  lineItemCount: number;
  hasInvoice: boolean;
  ageInDays: number;
  dispatchStatus: string | null;
  linkedPOs: LinkedPO[];
  poStatus: "none" | "pending" | "partial" | "received";
  lineItems: LineItemSummary[];
  totalDue: number;
  totalPaid: number;
  balanceDue: number;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const orders = await prisma.salesOrder.findMany({
        where: {
          status: "ORDER",
        },
        include: {
          customer: { select: { firstName: true, lastName: true } },
          store: { select: { name: true } },
          _count: { select: { lineItems: true } },
          lineItems: {
            select: {
              id: true,
              productName: true,
              partNo: true,
              orderedQuantity: true,
              netPrice: true,
              vatAmount: true,
              lineItemStatus: true,
            },
            where: { lineItemStatus: { not: "CANCELLED" } },
            orderBy: { lineNumber: "asc" },
          },
          purchaseOrders: {
            select: { id: true, poNumber: true, status: true, expectedDelivery: true },
          },
          payments: {
            select: { paymentAmount: true, status: true, isRefund: true },
          },
        },
        orderBy: { orderDate: "desc" },
      });

      const now = new Date();

      const items: AwaitingDeliveryOrder[] = orders.map((o) => {
        const custFirst = o.customer?.firstName ?? "";
        const custLast = o.customer?.lastName ?? "";
        const ageInDays = Math.floor(
          (now.getTime() - new Date(o.orderDate ?? now).getTime()) / 86400000,
        );

        const linkedPOs: LinkedPO[] = o.purchaseOrders.map((po) => ({
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
        }));

        let poStatus: AwaitingDeliveryOrder["poStatus"] = "none";
        if (linkedPOs.length > 0) {
          const allReceived = linkedPOs.every(
            (p) => p.status === "RECEIVED_FULL" || p.status === "SHORT_CLOSED",
          );
          const someReceived = linkedPOs.some(
            (p) =>
              p.status === "RECEIVED_FULL" ||
              p.status === "SHORT_CLOSED" ||
              p.status === "RECEIVED_PARTIAL",
          );
          poStatus = allReceived ? "received" : someReceived ? "partial" : "pending";
        }

        return {
          id: o.id,
          orderno: o.orderno,
          orderDate: o.orderDate?.toISOString() ?? now.toISOString(),
          customerName: `${custFirst} ${custLast}`.trim() || o.salesperson || "Unknown",
          storeName: o.store?.name ?? o.storeLocation ?? null,
          lineItemCount: o._count.lineItems,
          hasInvoice: false,
          ageInDays,
          dispatchStatus: o.dispatchStatus,
          linkedPOs,
          poStatus,
          lineItems: o.lineItems.map((li) => ({
            id: li.id,
            productName: li.productName,
            partNo: li.partNo,
            orderedQuantity: Number(li.orderedQuantity ?? 1),
            netPrice: Number(li.netPrice ?? 0),
            lineItemStatus: li.lineItemStatus as string | null,
          })),
          ...computeBalance(o.lineItems, o.payments),
        };
      });

      // Summary by age bucket
      let thisMonth = 0;
      let oneToThree = 0;
      let threeToSix = 0;
      let sixToTwelve = 0;
      let overYear = 0;

      for (const item of items) {
        if (item.ageInDays <= 30) thisMonth++;
        else if (item.ageInDays <= 90) oneToThree++;
        else if (item.ageInDays <= 180) threeToSix++;
        else if (item.ageInDays <= 365) sixToTwelve++;
        else overYear++;
      }

      return res.json({
        items,
        total: items.length,
        summary: { thisMonth, oneToThree, threeToSix, sixToTwelve, overYear },
      });
    } catch (err: unknown) {
      logError("Failed to fetch awaiting delivery orders", err);
      return res.status(500).json({ error: "Failed to fetch awaiting delivery orders" });
    }
  },
);
