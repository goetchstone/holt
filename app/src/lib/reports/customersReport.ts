// /app/src/lib/reports/customersReport.ts
//
// Customer directory report: paginated, searchable customer list with order
// counts, lifetime spend, designer, address, and level. Extracted from the Pages
// API so the App Router page + tRPC procedure share one source of truth. Revenue
// statuses include RETURNED so returns net correctly (SALES_REVENUE rule).
// CLAUDE.md rule 33: cancelled lines are excluded from the lifetime-spend sum.

import { SalesOrderStatus } from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";
import { buildSearchFilter } from "@/lib/buildSearchFilter";

export interface CustomerReportRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  creditBalance: number;
  isTradeAccount: boolean;
  tradeCompanyName: string | null;
  primaryDesigner: string | null;
  orderCount: number;
  totalSpend: number;
  lastOrderDate: string | null;
  address: string | null;
  customerLevel: number | null;
  peakCustomerLevel: number | null;
  customerGroup: string | null;
}

export interface CustomerReportResult {
  customers: CustomerReportRow[];
  total: number;
  page: number;
  limit: number;
  stats: {
    totalCustomers: number;
    withPhone: number;
    withEmail: number;
    tradeAccounts: number;
  };
}

export interface CustomersReportParams {
  search?: string | null;
  hasPhone?: boolean;
  minOrders?: number;
  groups?: string[];
  page?: number;
  limit?: number;
}

const COUNTED_STATUSES: SalesOrderStatus[] = [
  SalesOrderStatus.ORDER,
  SalesOrderStatus.FULFILLED,
  SalesOrderStatus.RETURNED,
];

export async function getCustomersReport(
  prisma: PrismaClient,
  params: CustomersReportParams = {},
): Promise<CustomerReportResult> {
  const search = params.search?.trim() || undefined;
  const hasPhone = params.hasPhone === true;
  const minOrders = params.minOrders;
  const groups = (params.groups ?? []).filter(Boolean);
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(500, Math.max(1, params.limit ?? 50));

  const searchFilter = buildSearchFilter(search, ["firstName", "lastName", "email", "phone"]);
  const where: Prisma.CustomerWhereInput = (searchFilter ?? {}) as Prisma.CustomerWhereInput;

  if (hasPhone) {
    where.phone = { not: null };
  }
  if (groups.length > 0) {
    where.customerGroup = { in: groups };
  }

  const [rawCustomers, total, withPhone, withEmail, tradeAccounts] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      include: {
        primaryDesigner: { select: { displayName: true } },
        addresses: { take: 1, select: { address1: true, city: true, state: true, zip: true } },
        salesOrders: {
          where: { status: { in: COUNTED_STATUSES } },
          select: {
            orderDate: true,
            // Rule 33: cancelled lines must not inflate lifetime spend. (The
            // legacy Pages report omitted this filter — fixed in the port.)
            lineItems: {
              where: { lineItemStatus: { not: "CANCELLED" } },
              select: { netPrice: true },
            },
          },
        },
      },
    }),
    prisma.customer.count({ where }),
    prisma.customer.count({ where: { ...where, phone: { not: null } } }),
    prisma.customer.count({ where: { ...where, email: { not: null } } }),
    prisma.customer.count({ where: { ...where, isTradeAccount: true } }),
  ]);

  let customers: CustomerReportRow[] = rawCustomers.map((c) => {
    const orderCount = c.salesOrders.length;
    const totalSpend = c.salesOrders.reduce(
      (sum, o) => sum + o.lineItems.reduce((s, li) => s + Number(li.netPrice), 0),
      0,
    );
    const lastOrder = c.salesOrders.reduce<Date | null>((latest, o) => {
      if (!o.orderDate) return latest;
      const d = new Date(o.orderDate);
      return latest === null || d > latest ? d : latest;
    }, null);
    const firstAddr = c.addresses[0];
    const addr = firstAddr
      ? [firstAddr.address1, firstAddr.city, firstAddr.state, firstAddr.zip]
          .filter(Boolean)
          .join(", ")
      : null;

    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      creditBalance: Number(c.creditBalance),
      isTradeAccount: c.isTradeAccount,
      tradeCompanyName: c.tradeCompanyName,
      primaryDesigner: c.primaryDesigner?.displayName ?? null,
      orderCount,
      totalSpend: Math.round(totalSpend * 100) / 100,
      lastOrderDate: lastOrder ? lastOrder.toISOString().slice(0, 10) : null,
      address: addr || null,
      customerLevel: c.customerLevel,
      peakCustomerLevel: c.peakCustomerLevel,
      customerGroup: c.customerGroup,
    };
  });

  if (minOrders !== undefined && !Number.isNaN(minOrders)) {
    customers = customers.filter((c) => c.orderCount >= minOrders);
  }

  return {
    customers,
    total,
    page,
    limit,
    stats: { totalCustomers: total, withPhone, withEmail, tradeAccounts },
  };
}
