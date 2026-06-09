// /app/src/lib/reports/salespersonDetail.ts
//
// Salesperson detail report: sales broken down by month and customer for one
// salesperson within a calendar year. Handles 50/50 split attribution when
// splitWithId is set. Extracted from the Pages API so the App Router page +
// tRPC procedure share one source of truth; the caller-vs-requested
// authorization stays in the tRPC procedure (it needs the session). CLAUDE.md
// rule 33 + RETURNED included (returns carry negative line items that net out
// rewrite chains and refunds).

import type { PrismaClient } from "@prisma/client";
import { buildLineItemWhere } from "@/lib/salesBySalesperson";

export interface LineItemDetail {
  partNo: string;
  productName: string;
  qty: number;
  netPrice: number;
}

export interface OrderDetail {
  orderno: string;
  orderDate: string;
  netSales: number;
  isSplit: boolean;
  lineItems: LineItemDetail[];
}

export interface CustomerRow {
  month: string;
  customerName: string;
  customerId: number | null;
  orderCount: number;
  netSales: number;
  isSplit: boolean;
  orders: OrderDetail[];
}

export interface MonthSummary {
  month: string;
  label: string;
  totalSales: number;
  orderCount: number;
  customers: CustomerRow[];
}

export interface SalespersonDetailResponse {
  salesperson: string;
  year: number;
  months: MonthSummary[];
  ytdTotal: number;
  ytdOrders: number;
}

export interface SalespersonDetailParams {
  salesperson: string;
  year?: number;
}

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface OrderCustomer {
  id: number;
  firstName: string | null;
  lastName: string | null;
  tradeCompanyName: string | null;
}

function resolveCustomerName(customer: OrderCustomer | null): string {
  if (!customer) return "Unknown";
  const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return fullName || customer.tradeCompanyName || "Unknown";
}

function getOrCreateCustomerRow(
  custMap: Map<string, CustomerRow>,
  custKey: string,
  monthKey: string,
  customerName: string,
  customerId: number | null,
): CustomerRow {
  let row = custMap.get(custKey);
  if (!row) {
    row = {
      month: monthKey,
      customerName,
      customerId,
      orderCount: 0,
      netSales: 0,
      isSplit: false,
      orders: [],
    };
    custMap.set(custKey, row);
  }
  return row;
}

export async function getSalespersonDetail(
  prisma: PrismaClient,
  params: SalespersonDetailParams,
): Promise<SalespersonDetailResponse> {
  const salesperson = params.salesperson;
  const year = params.year ?? new Date().getUTCFullYear();
  const startDate = new Date(Date.UTC(year, 0, 1));
  const endDate = new Date(Date.UTC(year + 1, 0, 1));

  // Resolve staff (incl. aliases) for split attribution + name OR-match.
  // Aliases let Sandy's row (`displayName='Sandy'`, alias='Sandra Matheny')
  // match her the POS-imported orders. Issue #274 / ROADMAP Short-Term #12.
  const staffRecord = await prisma.staffMember.findFirst({
    where: { displayName: { equals: salesperson, mode: "insensitive" } },
    select: { id: true, aliases: true },
  });
  const staffId = staffRecord?.id ?? null;
  const matchNames = [
    salesperson,
    ...(staffRecord?.aliases ?? []).filter((a) => a.toLowerCase() !== salesperson.toLowerCase()),
  ];

  // Fetch all orders where this person is primary or split partner
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: startDate, lt: endDate },
      status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
      OR: [
        ...matchNames.map((name) => ({
          salesperson: { equals: name, mode: "insensitive" as const },
        })),
        ...(staffId !== null ? [{ salesPersonId: staffId }] : []),
        ...(staffId !== null ? [{ splitWithId: staffId }] : []),
      ],
    },
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      splitWithId: true,
      customer: { select: { id: true, firstName: true, lastName: true, tradeCompanyName: true } },
      lineItems: {
        // Excludes cancelled lines (rule 33) and the delivery + freight
        // pass-throughs. Labor stays included.
        where: buildLineItemWhere([], false),
        select: {
          netPrice: true,
          partNo: true,
          productName: true,
          orderedQuantity: true,
        },
      },
    },
  });

  // Group by month -> customer
  const monthMap = new Map<string, Map<string, CustomerRow>>();

  for (const order of orders) {
    if (!order.orderDate) continue;

    const d = new Date(order.orderDate);
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

    const customerName = resolveCustomerName(order.customer);
    const customerId = order.customer?.id ?? null;
    const isSplit = order.splitWithId !== null;
    const multiplier = isSplit ? 0.5 : 1;
    const orderNet = order.lineItems.reduce((sum, li) => sum + Number(li.netPrice), 0) * multiplier;

    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, new Map());
    }
    const custMap = monthMap.get(monthKey)!;
    const custKey = customerId !== null ? String(customerId) : customerName;

    const row = getOrCreateCustomerRow(custMap, custKey, monthKey, customerName, customerId);
    row.orderCount += 1;
    row.netSales += orderNet;
    if (isSplit) row.isSplit = true;
    row.orders.push({
      orderno: order.orderno,
      orderDate: d.toISOString().slice(0, 10),
      netSales: orderNet,
      isSplit,
      lineItems: order.lineItems.map((li) => ({
        partNo: li.partNo || "",
        productName: li.productName || "",
        qty: Number(li.orderedQuantity) || 1,
        netPrice: Number(li.netPrice) * multiplier,
      })),
    });
  }

  const months: MonthSummary[] = [];
  const sortedKeys = Array.from(monthMap.keys()).sort((a, b) => a.localeCompare(b));

  for (const monthKey of sortedKeys) {
    const custMap = monthMap.get(monthKey)!;
    const customers = Array.from(custMap.values()).sort((a, b) => b.netSales - a.netSales);
    const monthIdx = Number.parseInt(monthKey.split("-")[1], 10) - 1;

    months.push({
      month: monthKey,
      label: MONTH_LABELS[monthIdx] || monthKey,
      totalSales: customers.reduce((sum, c) => sum + c.netSales, 0),
      orderCount: customers.reduce((sum, c) => sum + c.orderCount, 0),
      customers,
    });
  }

  const ytdTotal = months.reduce((sum, m) => sum + m.totalSales, 0);
  const ytdOrders = months.reduce((sum, m) => sum + m.orderCount, 0);

  return {
    salesperson,
    year,
    months,
    ytdTotal,
    ytdOrders,
  };
}
