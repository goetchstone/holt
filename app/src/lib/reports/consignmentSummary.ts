// /app/src/lib/reports/consignmentSummary.ts
//
// Consignment summary report: item counts and outstanding-balance math grouped
// by status and by vendor. Extracted from the Pages API so the App Router page
// and any caller share one source of truth.

import type { PrismaClient } from "@prisma/client";

export interface ConsignmentSummaryResponse {
  statusCounts: Array<{ status: string; count: number; totalCost: number }>;
  byVendor: Array<{
    vendorId: number;
    vendorName: string;
    onFloor: number;
    onApproval: number;
    sold: number;
    paid: number;
    returned: number;
    missing: number;
    totalItems: number;
    soldValue: number;
    floorValue: number;
  }>;
  totals: {
    totalItems: number;
    onFloor: number;
    sold: number;
    outstanding: number;
    outstandingValue: number;
    paidThisYear: number;
    paidThisYearValue: number;
  };
}

interface VendorAccum {
  vendorId: number;
  vendorName: string;
  onFloor: number;
  onApproval: number;
  sold: number;
  paid: number;
  returned: number;
  missing: number;
  totalItems: number;
  soldValue: number;
  floorValue: number;
}

interface RunningTotals {
  totalItems: number;
  onFloor: number;
  sold: number;
  outstanding: number;
  outstandingValue: number;
  paidThisYear: number;
  paidThisYearValue: number;
}

interface ConsignmentItemRow {
  status: string;
  cost: unknown;
  paidDate: Date | null;
  consignmentPaymentBatchId: number | null;
  vendorId: number;
  vendor: { id: number; name: string };
}

function tallyStatus(
  statusMap: Map<string, { count: number; totalCost: number }>,
  status: string,
  cost: number,
): void {
  const existing = statusMap.get(status);
  if (existing) {
    existing.count++;
    existing.totalCost += cost;
  } else {
    statusMap.set(status, { count: 1, totalCost: cost });
  }
}

function getOrCreateVendor(
  vendorMap: Map<number, VendorAccum>,
  vendorId: number,
  vendorName: string,
): VendorAccum {
  let v = vendorMap.get(vendorId);
  if (!v) {
    v = {
      vendorId,
      vendorName,
      onFloor: 0,
      onApproval: 0,
      sold: 0,
      paid: 0,
      returned: 0,
      missing: 0,
      totalItems: 0,
      soldValue: 0,
      floorValue: 0,
    };
    vendorMap.set(vendorId, v);
  }
  return v;
}

function applyStatusToVendor(
  v: VendorAccum,
  status: string,
  cost: number,
  hasPaymentBatch: boolean,
): void {
  v.totalItems++;
  switch (status) {
    case "ON_FLOOR":
      v.onFloor++;
      v.floorValue += cost;
      break;
    case "ON_APPROVAL":
      v.onApproval++;
      break;
    case "SOLD":
      v.sold++;
      // soldValue = cost of SOLD items with no payment batch (owed to vendor)
      if (!hasPaymentBatch) v.soldValue += cost;
      break;
    case "PAID":
      v.paid++;
      break;
    case "RETURNED_VENDOR":
      v.returned++;
      break;
    case "MISSING":
      v.missing++;
      break;
  }
}

function applyToTotals(
  totals: RunningTotals,
  item: ConsignmentItemRow,
  cost: number,
  thisYear: number,
): void {
  totals.totalItems++;
  if (item.status === "ON_FLOOR") totals.onFloor++;
  if (item.status === "SOLD") {
    totals.sold++;
    if (!item.consignmentPaymentBatchId) {
      totals.outstanding++;
      totals.outstandingValue += cost;
    }
  }
  if (item.status === "PAID") {
    const paidYear = item.paidDate ? new Date(item.paidDate).getFullYear() : null;
    if (paidYear === thisYear) {
      totals.paidThisYear++;
      totals.paidThisYearValue += cost;
    }
  }
}

export async function getConsignmentSummary(
  prisma: PrismaClient,
): Promise<ConsignmentSummaryResponse> {
  const items = await prisma.consignmentItem.findMany({
    select: {
      status: true,
      cost: true,
      paidDate: true,
      consignmentPaymentBatchId: true,
      vendorId: true,
      vendor: { select: { id: true, name: true } },
    },
  });

  const thisYear = new Date().getFullYear();
  const statusMap = new Map<string, { count: number; totalCost: number }>();
  const vendorMap = new Map<number, VendorAccum>();
  const totals: RunningTotals = {
    totalItems: 0,
    onFloor: 0,
    sold: 0,
    outstanding: 0,
    outstandingValue: 0,
    paidThisYear: 0,
    paidThisYearValue: 0,
  };

  for (const item of items as ConsignmentItemRow[]) {
    const cost = Number(item.cost);
    const status = item.status;
    tallyStatus(statusMap, status, cost);
    const v = getOrCreateVendor(vendorMap, item.vendorId, item.vendor.name);
    applyStatusToVendor(v, status, cost, item.consignmentPaymentBatchId !== null);
    applyToTotals(totals, item, cost, thisYear);
  }

  const statusCounts = Array.from(statusMap.entries())
    .map(([status, data]) => ({
      status,
      count: data.count,
      totalCost: Math.round(data.totalCost * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);

  const byVendor = Array.from(vendorMap.values())
    .map((v) => ({
      ...v,
      soldValue: Math.round(v.soldValue * 100) / 100,
      floorValue: Math.round(v.floorValue * 100) / 100,
    }))
    .sort((a, b) => b.totalItems - a.totalItems);

  return {
    statusCounts,
    byVendor,
    totals: {
      totalItems: totals.totalItems,
      onFloor: totals.onFloor,
      sold: totals.sold,
      outstanding: totals.outstanding,
      outstandingValue: Math.round(totals.outstandingValue * 100) / 100,
      paidThisYear: totals.paidThisYear,
      paidThisYearValue: Math.round(totals.paidThisYearValue * 100) / 100,
    },
  };
}
