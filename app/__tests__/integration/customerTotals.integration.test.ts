// /app/__tests__/integration/customerTotals.integration.test.ts
//
// Every screen that totals an order agrees with the register (`computeBalance`): only lines
// still owed count, only payments that settled count, and a refund takes money back whatever
// its stored sign (Holt's own refunds are stored positive, imported ones negative). Found on the
// 2026-11-11 re-check of the October bug list: the customer portal, the service lookup and the
// customer page summed every row; the order screen's API, Open Orders' deposits read the stored
// `SalesOrder.totalPaid` only the import writes; Balance Aging added imported refunds the wrong
// way; the daily reconciliation counted Holt's refunds as money in.
//
// One order holds every kind of row. The figures, worked by hand:
//   lines still owed: $1,000 + $63.50 tax, and the replacement $300 + $19.05 = $1,382.55
//     (a cancelled $500 line and the replaced $300 line don't count)
//   paid: $600 deposit + $100 imported payment − $50 Holt refund − $25 imported refund = $625
//     (a $200 pending checkout and a $150 voided payment don't count)
//   owing: $1,382.55 − $625 = $757.55

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { generatePortalToken } from "@/lib/portalToken";
import { calculateOrderBalance } from "@/lib/paymentService";
import { getOpenOrdersReport } from "@/lib/reports/openOrders";
import { getBalanceAging } from "@/lib/reports/balanceAging";
import { computeDailyReconciliation } from "@/lib/dailyReconciliation";
import { overpaidAfterLineChange } from "@/lib/sales/cancelOrder";
import portalOrderRoute from "@/pages/api/portal/order";
import serviceLookupRoute from "@/pages/api/service/customer-lookup";
import customerRoute from "@/pages/api/customers/[id]/index";
import orderRoute from "@/pages/api/sales/orders/[id]";
import weeklyRoute from "@/pages/api/dashboard/weekly";
import leadsRoute from "@/pages/api/leads/index";

const sessionMock = getServerSession as jest.Mock;

const DUE = 1382.55;
const PAID = 625;
const OWING = 757.55;
// Noon UTC on a weekday, inside the business day in any US zone.
const SALE_DAY = new Date("2026-06-10T16:00:00Z");

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, query: Record<string, string>) {
  const res = {
    statusCode: 200,
    body: undefined as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  const req = {
    method: "GET",
    query,
    body: {},
    cookies: {},
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
  await route(req, res as unknown as NextApiResponse);
  return res;
}

let customerId: number;
let orderId: number;

async function seedOrder() {
  const customer = await prisma.customer.create({
    data: { firstName: "Wren", lastName: "Halloway", phone: "5550100199" },
  });
  customerId = customer.id;
  const line = (n: number, netPrice: number, vatAmount: number, status: string) => ({
    lineNumber: n,
    productName: `Line ${n}`,
    netPrice,
    vatAmount,
    cost: 0,
    orderedQuantity: 1,
    lineItemStatus: status as "ACTIVE",
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "TOT-1",
      status: "ORDER",
      orderDate: SALE_DAY,
      customerId,
      // The import's stored copy, deliberately wrong: nothing may read it.
      totalPaid: 999,
      lineItems: {
        create: [
          line(1, 1000, 63.5, "ACTIVE"),
          line(2, 500, 31.75, "CANCELLED"),
          line(3, 300, 19.05, "REPLACED"),
          line(4, 300, 19.05, "ACTIVE"),
        ],
      },
    },
  });
  orderId = order.id;
  const pay = (
    paymentAmount: number,
    status: "COMPLETED" | "PENDING" | "VOIDED" | null,
    isRefund = false,
  ) => ({
    salesOrderId: orderId,
    paymentAmount,
    status,
    isRefund,
    paymentType: "Card",
    paymentDate: SALE_DAY,
  });
  await prisma.payment.createMany({
    data: [
      pay(600, "COMPLETED"),
      pay(200, "PENDING"),
      pay(150, "VOIDED"),
      pay(50, "COMPLETED", true), // Holt's own refund: stored positive
      pay(-25, null, true), // an imported refund: stored negative, no status
      pay(100, null), // an imported payment, no status
    ],
  });
}

async function signInOwner() {
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "owner", displayName: "Owner", role: "SUPER_ADMIN", roleId: role.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });
}

// The portal's link is a signed token; the secret is set for this file and put back after.
const savedSecret = process.env.NEXTAUTH_SECRET;
beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "customer-totals-test-secret";
});

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await signInOwner();
  await seedOrder();
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
  await prisma.$disconnect();
});

describe("every screen totals an order the register's way", () => {
  it("the register itself: the figures worked by hand", async () => {
    const balance = await calculateOrderBalance(orderId);
    expect(balance).toMatchObject({ totalDue: DUE, totalPaid: PAID, balanceDue: OWING });
  });

  it("the customer portal shows only what's owed and what settled, refunds as money back", async () => {
    const res = await call(portalOrderRoute, { token: generatePortalToken(orderId, customerId) });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ totalAmount: DUE, totalPaid: PAID, balanceDue: OWING });
    expect(res.body.lineItems.map((l: { productName: string }) => l.productName)).toEqual([
      "Line 1",
      "Line 4",
    ]);
    const amounts = res.body.payments.map((p: { paymentAmount: number }) => p.paymentAmount);
    expect(amounts.sort((a: number, b: number) => a - b)).toEqual([-50, -25, 100, 600]);
  });

  it("the service desk's customer lookup", async () => {
    const res = await call(serviceLookupRoute, { customerId: String(customerId) });

    expect(res.statusCode).toBe(200);
    expect(res.body.orders[0]).toMatchObject({
      totalDue: DUE,
      totalPaid: PAID,
      balanceDue: OWING,
    });
  });

  it("the customer page", async () => {
    const res = await call(customerRoute, { id: String(customerId) });

    expect(res.statusCode).toBe(200);
    expect(res.body.salesOrders[0]).toMatchObject({
      calculatedOrderTotal: DUE,
      calculatedTotalPaid: PAID,
    });
  });

  it("the order screen's paid figure comes from the payments, not the import's stored copy", async () => {
    const res = await call(orderRoute, { id: String(orderId) });

    expect(res.statusCode).toBe(200);
    expect(res.body.totalPaid).toBe(PAID);
  });

  it("Open Orders' deposits count money taken in Holt, and only orders with something paid", async () => {
    // A second open order whose only payment is a pending checkout: no deposit.
    const other = await prisma.salesOrder.create({
      data: { orderno: "TOT-2", status: "ORDER", orderDate: SALE_DAY, customerId },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: other.id,
        paymentAmount: 400,
        status: "PENDING",
        isRefund: false,
        paymentType: "Card",
        paymentDate: SALE_DAY,
      },
    });

    const report = await getOpenOrdersReport(prisma);

    expect(report.customerDeposits).toEqual({ totalOutstanding: PAID, orderCount: 1 });
  });

  it("Balance Aging takes both kinds of refund off what's been paid", async () => {
    const result = await getBalanceAging(prisma);
    const row = result.rows.find((r) => r.orderno === "TOT-1");

    // Whole dollars on this report: $1,382.55 total, $625 paid after refunds, $757.55 owing.
    expect(row).toMatchObject({ orderTotal: 1383, totalPaid: 625, balanceDue: 758 });
  });

  it("the daily reconciliation counts the day's money the journal's way", async () => {
    const result = await computeDailyReconciliation({
      date: new Date("2026-06-10T00:00:00Z"),
      timeZone: "America/New_York",
      client: prisma,
    });

    expect(result.source.cash).toBe(PAID);
  });

  it("the weekly dashboard counts a replaced line once and a cancelled line not at all", async () => {
    const dept = await prisma.department.create({ data: { name: "Upholstery" } });
    const vendor = await prisma.vendor.create({ data: { name: "Maker" } });
    const category = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id },
    });
    const sofa = await prisma.product.create({
      data: {
        productNumber: "SOFA-W",
        name: "Sofa",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: category.id,
      },
    });
    const line = (n: number, netPrice: number, status: string) => ({
      lineNumber: n,
      productId: sofa.id,
      netPrice,
      cost: 0,
      orderedQuantity: 1,
      lineItemStatus: status as "ACTIVE",
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "TOT-W",
        status: "ORDER",
        orderDate: SALE_DAY,
        customerId,
        lineItems: {
          create: [line(1, 1000, "ACTIVE"), line(2, 1000, "REPLACED"), line(3, 1500, "CANCELLED")],
        },
      },
    });

    // The week from June 7 holds the sale; TOT-1's lines have no product, so no department.
    const res = await call(weeklyRoute, { type: "company", startDate: "2026-06-07" });

    expect(res.statusCode).toBe(200);
    const total = res.body.rows.reduce((sum: number, r: { actual: number }) => sum + r.actual, 0);
    expect(total).toBe(1000);
  });

  it("a lead's spend is the customer's sales, not their quotes or dropped lines", async () => {
    await prisma.salesOrder.create({
      data: {
        orderno: "TOT-Q",
        status: "QUOTE",
        orderDate: SALE_DAY,
        customerId,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 5200,
              cost: 0,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    await prisma.lead.create({ data: { source: "WALK_IN", customerId, firstName: "Wren" } });

    const res = await call(leadsRoute, {});

    expect(res.statusCode).toBe(200);
    const lead = res.body.data.find((l: { customerId: number }) => l.customerId === customerId);
    // TOT-1's lines still owed, before tax: $1,000 + $300. The $5,200 quote isn't spend.
    expect(lead).toMatchObject({ orderCount: 1, totalSpend: 1300 });
  });

  it("cancelling a line on an imported order counts its imported refund", async () => {
    // $600 + $200 + $200 of lines, a $1,000 imported payment and a $300 imported refund:
    // $700 paid. Cancelling a $200 line leaves $800 owed, so nothing is overpaid.
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "TOT-I",
        status: "ORDER",
        orderDate: SALE_DAY,
        customerId,
        lineItems: {
          create: [600, 200, 200].map((netPrice, i) => ({
            lineNumber: i + 1,
            netPrice,
            cost: 0,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE" as const,
          })),
        },
        payments: {
          create: [
            {
              paymentAmount: 1000,
              status: null,
              isRefund: false,
              paymentType: "Card",
              paymentDate: SALE_DAY,
            },
            {
              paymentAmount: -300,
              status: null,
              isRefund: true,
              paymentType: "Card",
              paymentDate: SALE_DAY,
            },
          ],
        },
      },
      include: { lineItems: true },
    });

    await expect(overpaidAfterLineChange(order.id, order.lineItems[2].id, 0)).resolves.toBeNull();
  });
});
