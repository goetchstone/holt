// /app/src/lib/reports/openOrders.ts
//
// Open-orders report query, extracted from the Pages API handler so it can be
// shared by the App Router server component AND the tRPC procedure (and the
// legacy REST route during migration) — one source of truth (CLAUDE.md rule 6).
// Pure data access: takes the prisma client, returns the typed report shape.
// No HTTP, no framework types — unit/integration testable on its own.

import type { PrismaClient } from "@prisma/client";
import { PurchaseOrderStatus } from "@prisma/client";

export interface OpenOrdersReport {
  purchaseOrders: Array<{
    id: number;
    poNumber: string;
    vendor: string;
    orderDate: string;
    expectedDate: string | null;
    totalCost: number;
    itemCount: number;
    status: string;
    daysOpen: number;
    isOverdue: boolean;
  }>;
  summary: {
    totalPOs: number;
    totalValue: number;
    overduePOs: number;
    overdueValue: number;
  };
  customerDeposits: {
    totalOutstanding: number;
    orderCount: number;
  };
}

const CLOSED_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.RECEIVED_FULL,
  PurchaseOrderStatus.CANCELLED,
];

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getOpenOrdersReport(prisma: PrismaClient): Promise<OpenOrdersReport> {
  const nowMs = Date.now();

  const [rawPOs, depositOrders] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { status: { notIn: CLOSED_STATUSES } },
      select: {
        id: true,
        poNumber: true,
        vendor: { select: { name: true } },
        orderDate: true,
        expectedDelivery: true,
        status: true,
        lineItems: { select: { orderedQuantity: true, unitCost: true } },
      },
      orderBy: { orderDate: "asc" },
    }),
    prisma.salesOrder.findMany({
      where: { status: "ORDER", totalPaid: { not: null } },
      select: { totalPaid: true },
    }),
  ]);

  const purchaseOrders = rawPOs.map((po) => {
    const totalCost = po.lineItems.reduce(
      (sum, li) => sum + Number(li.unitCost || 0) * Number(li.orderedQuantity || 0),
      0,
    );
    const itemCount = po.lineItems.reduce((sum, li) => sum + Number(li.orderedQuantity || 0), 0);
    const daysOpen = Math.floor((nowMs - new Date(po.orderDate).getTime()) / MS_PER_DAY);
    const isOverdue =
      po.expectedDelivery !== null && new Date(po.expectedDelivery).getTime() < nowMs;

    return {
      id: po.id,
      poNumber: po.poNumber,
      vendor: po.vendor.name,
      orderDate: po.orderDate.toISOString().slice(0, 10),
      expectedDate: po.expectedDelivery ? po.expectedDelivery.toISOString().slice(0, 10) : null,
      totalCost: round2(totalCost),
      itemCount: Math.round(itemCount),
      status: po.status,
      daysOpen,
      isOverdue,
    };
  });

  const summary = purchaseOrders.reduce(
    (acc, po) => {
      acc.totalPOs += 1;
      acc.totalValue += po.totalCost;
      if (po.isOverdue) {
        acc.overduePOs += 1;
        acc.overdueValue += po.totalCost;
      }
      return acc;
    },
    { totalPOs: 0, totalValue: 0, overduePOs: 0, overdueValue: 0 },
  );
  summary.totalValue = round2(summary.totalValue);
  summary.overdueValue = round2(summary.overdueValue);

  const totalOutstanding = depositOrders.reduce((sum, o) => sum + Number(o.totalPaid || 0), 0);

  return {
    purchaseOrders,
    summary,
    customerDeposits: {
      totalOutstanding: round2(totalOutstanding),
      orderCount: depositOrders.length,
    },
  };
}
