// /app/src/pages/api/warehouse/inbound-dashboard.ts
//
// Returns all open purchase orders as a flat list. The frontend handles
// grouping by month/week/day and filtering by summary card clicks.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export interface InboundPO {
  id: number;
  poNumber: string;
  vendorName: string;
  vendorId: number;
  orderDate: string;
  expectedDelivery: string | null;
  status: string;
  lineItemCount: number;
  receivedItemCount: number;
  totalCost: number;
  ageInDays: number;
  orderType: "stock" | "customer";
  customerName: string | null;
  orderno: string | null;
  salesOrderId: number | null;
  departments: string[];
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const purchaseOrders = await prisma.purchaseOrder.findMany({
        where: {
          status: { in: ["DRAFT", "SUBMITTED", "CONFIRMED", "RECEIVED_PARTIAL"] },
          isReturn: { not: true },
        },
        orderBy: { expectedDelivery: "asc" },
        include: {
          vendor: { select: { id: true, name: true } },
          lineItems: {
            select: {
              unitCost: true,
              orderedQuantity: true,
              product: { select: { department: { select: { name: true } } } },
            },
          },
          salesOrder: {
            select: {
              id: true,
              orderno: true,
              customer: { select: { firstName: true, lastName: true } },
            },
          },
          _count: { select: { receivingRecords: true } },
        },
      });

      const now = new Date();
      const items: InboundPO[] = purchaseOrders.map((po) => {
        const orderDate = new Date(po.orderDate);
        const ageInDays = Math.floor((now.getTime() - orderDate.getTime()) / 86400000);
        const totalCost = po.lineItems.reduce(
          (sum, li) => sum + Number(li.unitCost) * Number(li.orderedQuantity),
          0,
        );

        const isCustomerOrder = po.salesOrder !== null;
        const custFirst = po.salesOrder?.customer?.firstName ?? "";
        const custLast = po.salesOrder?.customer?.lastName ?? "";
        const customerName = isCustomerOrder ? `${custFirst} ${custLast}`.trim() || null : null;

        const departments = [
          ...new Set(
            po.lineItems
              .map((li) => li.product?.department?.name)
              .filter((d): d is string => d !== undefined && d !== null),
          ),
        ];

        return {
          id: po.id,
          poNumber: po.poNumber,
          vendorName: po.vendor.name,
          vendorId: po.vendor.id,
          orderDate: po.orderDate.toISOString(),
          expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
          status: po.status,
          lineItemCount: po.lineItems.length,
          receivedItemCount: po._count.receivingRecords,
          totalCost: Math.round(totalCost * 100) / 100,
          ageInDays,
          orderType: isCustomerOrder ? "customer" : "stock",
          customerName,
          orderno: po.salesOrder?.orderno ?? null,
          salesOrderId: po.salesOrder?.id ?? null,
          departments,
        };
      });

      const vendors = [...new Set(items.map((i) => i.vendorName))].sort((a, b) =>
        a.localeCompare(b),
      );
      const allDepartments = [...new Set(items.flatMap((i) => i.departments))].sort((a, b) =>
        a.localeCompare(b),
      );

      return res.json({ items, total: items.length, vendors, departments: allDepartments });
    } catch (err: unknown) {
      logError("Failed to fetch inbound dashboard data", err);
      return res.status(500).json({ error: "Failed to fetch inbound dashboard" });
    }
  },
);
