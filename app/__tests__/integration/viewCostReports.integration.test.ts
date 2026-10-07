// /app/__tests__/integration/viewCostReports.integration.test.ts
//
// "View cost" (catalog.cost, SEC-14) over the reports on "View reports":
// Sales by Salesperson (summary, drill-down and CSV export), the Designer
// Dashboard's average margin and Open Orders' PO values. The procedures move
// from "any signed-in user" to the page's own key, "View reports", and answer
// View cost beside it from the same staff read; a caller without View cost
// gets the same report without cost or margin (strip, never deny).
//
// Real router, real routes, real gates, real database; the session readers
// (next-auth, next/headers) and redirect are the only mocks.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { getOpenOrdersReport } from "@/lib/reports/openOrders";
import OpenOrdersPage from "@/app/(dashboard)/app/reports/open-orders/page";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";
import exportRoute from "@/pages/api/reports/sales-by-salesperson/export";

const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };

function reportsAs(userId: string, tokenRole: string) {
  const ctx: TrpcContext = {
    userId,
    userEmail: `${userId}@example.com`,
    tokenRole,
    impersonate: null,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx).reports;
}

/** Every key at every depth that carries cost or margin (the flag excepted). */
function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost|margin/i.test(k) && k !== "costVisible" ? [k] : []),
      ...costKeys(v),
    ]);
  }
  return [];
}

async function exportCsv(userId: string, role: string, level: "group" | "items", groupKey = "") {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
    role,
  });
  let status = 200;
  let body = "";
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      body = JSON.stringify(p);
      return this;
    },
    send(p: string) {
      body = p;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await exportRoute(
    {
      method: "GET",
      query: { ...RANGE, groupBy: "salesperson", level, groupKey },
      body: {},
      cookies: {},
    } as unknown as NextApiRequest,
    res,
  );
  return { status, body };
}

async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: enumRole as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  await makeStaff("mia", "MANAGER");
  // A custom role that runs reports, without View cost.
  await prisma.role.create({
    data: {
      key: "ANALYST",
      name: "Analyst",
      isSystem: false,
      permissions: { create: [{ permission: "reporting.read" }] },
    },
  });
  const ana = await makeStaff("ana", "ANALYST", "DESIGNER");
  await makeStaff("reg", "REGISTER");

  // One revenue order sold by the analyst, so their own view is not empty.
  await prisma.salesOrder.create({
    data: {
      orderno: "SO-REPORT-1",
      status: "ORDER",
      orderDate: new Date("2026-09-15T15:00:00Z"),
      salesPersonId: ana.id,
      salesperson: "ana",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Quarry Sofa",
            orderedQuantity: 1,
            netPrice: 1000,
            cost: 400,
            vatRate: 0,
            vatAmount: 0,
          },
          {
            lineNumber: 2,
            productName: "Quarry Ottoman",
            orderedQuantity: 1,
            netPrice: 500,
            cost: 200,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
  await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-REPORT-1",
      vendorId: vendor.id,
      status: "CONFIRMED",
      orderDate: new Date("2026-09-20T15:00:00Z"),
      lineItems: { create: [{ partNo: "QH-1", orderedQuantity: 2, unitCost: 400 }] },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Sales by Salesperson follows View cost", () => {
  it("a holder gets cost, margin and margin %", async () => {
    const data = await reportsAs("mia", "MANAGER").salesBySalesperson(RANGE);
    expect(data.costVisible).toBe(true);
    expect(data.rows[0]).toMatchObject({ retail: 1500, cost: 600, margin: 900, itemCount: 2 });
    // The total counts line items, not rows (it had read as the number of salespeople).
    expect(data.total).toMatchObject({ retail: 1500, itemCount: 2 });
  });

  it("a role without View cost gets the same rows without cost or margin, not a refusal", async () => {
    const data = await reportsAs("ana", "DESIGNER").salesBySalesperson(RANGE);
    expect(data.costVisible).toBe(false);
    expect(data.rows[0]).toMatchObject({ retail: 1500, itemCount: 2 });
    expect(costKeys(data)).toEqual([]);

    const items = await reportsAs("ana", "DESIGNER").salesBySalespersonItems({
      ...RANGE,
      groupKey: data.rows[0].groupKey,
    });
    expect(items.map((i) => i.retail).sort()).toEqual([1000, 500].sort());
    expect(items[0]).toMatchObject({ orderno: "SO-REPORT-1" });
    expect(costKeys(items)).toEqual([]);
  });

  it("is on the page's key now: a role without View reports is refused", async () => {
    await expect(reportsAs("reg", "REGISTER").salesBySalesperson(RANGE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("the CSV export has the cost columns only for a holder", async () => {
    const holder = await exportCsv("mia", "MANAGER", "group");
    expect(holder.status).toBe(200);
    expect(holder.body).toMatch(/Retail,Cost,Margin,Margin %/);

    const blind = await exportCsv("ana", "DESIGNER", "group");
    expect(blind.status).toBe(200);
    expect(blind.body).toMatch(/Items,Retail\n/);
    expect(blind.body).not.toMatch(/Cost|Margin/);
    expect(blind.body).toMatch(/1500\.00/);
  });
});

describe("the Designer Dashboard's average margin follows View cost", () => {
  it("a holder gets it; a role without View cost gets null and the rest of the dashboard", async () => {
    // A fixed asOf: the dashboard counts the year to date of that day.
    const asOf = "2026-09-30";
    const holder = await reportsAs("mia", "MANAGER").designerDashboard({
      salesperson: "ana",
      asOf,
    });
    expect(holder.costVisible).toBe(true);
    expect(holder.sales.avgMargin).toBeCloseTo(0.6);

    const blind = await reportsAs("ana", "DESIGNER").designerDashboard({ asOf });
    expect(blind.costVisible).toBe(false);
    expect(blind.sales.avgMargin).toBeNull();
    expect(blind.sales.orderCount).toBe(1);
  });
});

describe("Open Orders follows View cost", () => {
  /** What the server page hands its client view, for one viewer. */
  async function pageData(userId: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: userId });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
    return (await OpenOrdersPage()).props.data;
  }

  it("the page sends the values only to a holder, and stays closed without View reports", async () => {
    const report = await getOpenOrdersReport(prisma);

    const holder = await pageData("mia");
    expect(holder.costVisible).toBe(true);
    expect(holder.summary).toMatchObject({ totalPOs: 1, totalValue: 800 });

    const blind = await pageData("ana");
    expect(blind.costVisible).toBe(false);
    expect(blind.summary).toEqual({ totalPOs: 1, overduePOs: expect.any(Number) });
    expect(blind.purchaseOrders[0]).toMatchObject({ poNumber: "PO-REPORT-1", itemCount: 2 });
    expect(costKeys(blind)).toEqual([]);
    expect(blind.customerDeposits).toEqual(report.customerDeposits);

    await expect(pageData("reg")).rejects.toThrow("REDIRECT /app");
  });
});
