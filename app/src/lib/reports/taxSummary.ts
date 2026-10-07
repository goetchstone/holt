// /app/src/lib/reports/taxSummary.ts
//
// Tax summary report: tax collected by month, store, and jurisdiction, sourced
// from invoices (by invoice date, not payment date). Extracted from the Pages
// API so the App Router page + tRPC procedure share one source of truth.
// SALES_REVENUE_STATUSES equivalent: ORDER / FULFILLED / RETURNED — RETURNED is
// included so refunded tax nets out.

import { SalesOrderStatus, type PrismaClient } from "@prisma/client";

export interface TaxSummaryResponse {
  dateRange: { start: string; end: string };
  totals: {
    taxCollected: number;
    invoiceCount: number;
    orderCount: number;
  };
  byMonth: Array<{ month: string; taxCollected: number; invoiceCount: number }>;
  byStore: Array<{ store: string; taxCollected: number; invoiceCount: number }>;
  byJurisdiction: Array<{
    jurisdiction: string;
    taxRate: number | null;
    taxCollected: number;
    invoiceCount: number;
  }>;
}

export interface TaxSummaryParams {
  startDate?: string;
  endDate?: string;
}

const COUNTED_STATUSES: SalesOrderStatus[] = [
  SalesOrderStatus.ORDER,
  SalesOrderStatus.FULFILLED,
  SalesOrderStatus.RETURNED,
];

export async function getTaxSummary(
  prisma: PrismaClient,
  params: TaxSummaryParams = {},
): Promise<TaxSummaryResponse> {
  const today = new Date();
  const defaultStart = `${today.getFullYear()}-01-01`;
  const defaultEnd = today.toISOString().slice(0, 10);

  const startStr = params.startDate || defaultStart;
  const endStr = params.endDate || defaultEnd;

  const startDate = new Date(`${startStr}T00:00:00.000Z`);
  const endDate = new Date(`${endStr}T23:59:59.999Z`);

  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: startDate, lte: endDate },
      salesOrder: { status: { in: COUNTED_STATUSES } },
    },
    select: {
      id: true,
      invoiceDate: true,
      taxAmount: true,
      salesOrderId: true,
      salesOrder: {
        select: {
          storeLocation: true,
          taxDistrict: {
            select: {
              shortName: true,
              rules: { select: { taxRate: true }, orderBy: { sortOrder: "asc" }, take: 1 },
            },
          },
          taxExemptReason: { select: { name: true } },
        },
      },
    },
  });

  const monthMap = new Map<string, { taxCollected: number; invoiceCount: number }>();
  const storeMap = new Map<string, { taxCollected: number; invoiceCount: number }>();
  const jurisdictionMap = new Map<
    string,
    { taxCollected: number; invoiceCount: number; taxRate: number | null }
  >();
  const orderIds = new Set<number>();

  let totalTax = 0;

  for (const inv of invoices) {
    // Legacy furniture tax report is per-SalesOrder; skip order-less invoices
    // (e.g. services invoices) now that Invoice.salesOrderId is optional.
    if (inv.salesOrderId == null || !inv.salesOrder) continue;
    const tax = Number(inv.taxAmount);

    totalTax += tax;
    orderIds.add(inv.salesOrderId);

    const month = inv.invoiceDate.toISOString().slice(0, 7);
    const monthEntry = monthMap.get(month) ?? { taxCollected: 0, invoiceCount: 0 };
    monthEntry.taxCollected += tax;
    monthEntry.invoiceCount += 1;
    monthMap.set(month, monthEntry);

    const store = inv.salesOrder.storeLocation ?? "Unknown";
    const storeEntry = storeMap.get(store) ?? { taxCollected: 0, invoiceCount: 0 };
    storeEntry.taxCollected += tax;
    storeEntry.invoiceCount += 1;
    storeMap.set(store, storeEntry);

    const district = inv.salesOrder.taxDistrict;
    const exemptReason = inv.salesOrder.taxExemptReason;
    let jurisdictionKey: string;
    let taxRate: number | null = null;
    if (district) {
      const rate = district.rules[0]?.taxRate;
      taxRate = rate != null ? Number(rate) : null;
      jurisdictionKey =
        taxRate != null
          ? `${district.shortName} ${(taxRate * 100).toFixed(2)}%`
          : district.shortName;
    } else if (exemptReason) {
      jurisdictionKey = `Exempt - ${exemptReason.name}`;
    } else {
      jurisdictionKey = "Unknown";
    }
    const jEntry = jurisdictionMap.get(jurisdictionKey) ?? {
      taxCollected: 0,
      invoiceCount: 0,
      taxRate,
    };
    jEntry.taxCollected += tax;
    jEntry.invoiceCount += 1;
    jurisdictionMap.set(jurisdictionKey, jEntry);
  }

  const byMonth = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      taxCollected: Math.round(v.taxCollected * 100) / 100,
      invoiceCount: v.invoiceCount,
    }));

  const byStore = [...storeMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([store, v]) => ({
      store,
      taxCollected: Math.round(v.taxCollected * 100) / 100,
      invoiceCount: v.invoiceCount,
    }));

  const byJurisdiction = [...jurisdictionMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([jurisdiction, v]) => ({
      jurisdiction,
      taxRate: v.taxRate,
      taxCollected: Math.round(v.taxCollected * 100) / 100,
      invoiceCount: v.invoiceCount,
    }));

  return {
    dateRange: { start: startStr, end: endStr },
    totals: {
      taxCollected: Math.round(totalTax * 100) / 100,
      invoiceCount: invoices.length,
      orderCount: orderIds.size,
    },
    byMonth,
    byStore,
    byJurisdiction,
  };
}
