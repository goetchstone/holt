// /app/src/lib/reports/poGaps.ts
//
// Open PO gaps report: open purchase orders missing an expected ship date (ESD)
// or a vendor acknowledgement. Extracted from the Pages API so the App Router
// page + any caller share one source of truth. Furniture-type lines are flagged
// because accessories/apparel don't require ESD/ack.

import type { PrismaClient } from "@prisma/client";

const FURNITURE_DEPTS = new Set([
  "Furniture",
  "Outdoor Furniture",
  "Dining Room",
  "Bedroom",
  "Window Treatments",
]);

export interface PoGapRow {
  id: number;
  poNumber: string;
  vendorName: string;
  orderDate: string;
  expectedDelivery: string | null;
  vendorAckNumber: string | null;
  vendorAckDate: string | null;
  status: string;
  lineItemCount: number;
  totalCost: number;
  missingESD: boolean;
  missingAck: boolean;
  hasFurniture: boolean;
}

export interface PoGapsResult {
  total: number;
  missingESD: number;
  missingAck: number;
  missingESDFurniture: number;
  missingAckFurniture: number;
  rows: PoGapRow[];
}

export async function getPoGaps(prisma: PrismaClient): Promise<PoGapsResult> {
  const openPOs = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["CONFIRMED", "RECEIVED_PARTIAL"] } },
    include: {
      vendor: { select: { name: true } },
      lineItems: {
        select: {
          id: true,
          partNo: true,
          productName: true,
          orderedQuantity: true,
          unitCost: true,
          product: { select: { department: { select: { id: true, name: true } } } },
        },
      },
    },
    orderBy: { orderDate: "asc" },
  });

  const rows: PoGapRow[] = openPOs.map((po) => {
    const hasFurniture = po.lineItems.some((li) =>
      FURNITURE_DEPTS.has(li.product?.department?.name ?? ""),
    );

    return {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.vendor.name,
      orderDate: po.orderDate.toISOString().slice(0, 10),
      expectedDelivery: po.expectedDelivery?.toISOString().slice(0, 10) ?? null,
      vendorAckNumber: po.vendorAckNumber,
      vendorAckDate: po.vendorAckDate?.toISOString().slice(0, 10) ?? null,
      status: po.status,
      lineItemCount: po.lineItems.length,
      totalCost: po.lineItems.reduce((sum, li) => sum + Number(li.unitCost || 0), 0),
      missingESD: !po.expectedDelivery,
      missingAck: !po.vendorAckNumber,
      hasFurniture,
    };
  });

  return {
    total: rows.length,
    missingESD: rows.filter((r) => r.missingESD).length,
    missingAck: rows.filter((r) => r.missingAck).length,
    missingESDFurniture: rows.filter((r) => r.missingESD && r.hasFurniture).length,
    missingAckFurniture: rows.filter((r) => r.missingAck && r.hasFurniture).length,
    rows,
  };
}
