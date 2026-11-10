// __tests__/integration/replacedLines.integration.test.ts
//
// A replaced line keeps its price, and its replacement carries the same item. Totals
// that left out only CANCELLED lines counted both (rule 33, COUNTED_LINE_STATUSES). This
// sells a $500 sofa and a $400 chair, then replaces the chair with a $400 one, and
// checks each kind of total says $900, not $1,300: the order screen, a Prisma report, the
// raw-SQL reports, a string-built query and the customer's ledger. Real database; only
// the session readers are stood in for.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { computeSourceBalance } from "@/lib/customerLedger";
import { recalculateCustomerLevels } from "@/lib/customerLeveling";
import { prisma } from "@/lib/prisma";
import { getDetailedSales } from "@/lib/reports/detailedSales";
import { getGrossMargin } from "@/lib/reports/grossMargin";
import { getSalesDaily } from "@/lib/reports/salesDaily";
import { getTopSellers } from "@/lib/reports/topSellers";
import { resetTestDb } from "@/lib/testing/withTestDb";
import orderRoute from "@/pages/api/sales/orders/[id]";
import lineRoute from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, method: string, query: Record<string, string>, body = {}) {
  const session = { user: { id: "boss", email: "boss@example.com" } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    { method, query, body, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload };
}

const DAY = "2026-10-15";
const SOLD = new Date(`${DAY}T16:00:00.000Z`);

async function sellAndReplace() {
  const vendor = await prisma.vendor.create({ data: { name: "Northfield" } });
  const department = await prisma.department.create({ data: { name: "Living Room" } });
  const category = await prisma.category.create({
    data: { name: "Seating", departmentId: department.id },
  });
  const product = (productNumber: string, name: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const sofa = await product("S-1", "Sofa");
  const chair = await product("C-1", "Chair");
  const buyer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-1",
      status: "ORDER",
      customerId: buyer.id,
      storeLocation: "Main Street",
      salesperson: "Sam",
      orderDate: SOLD,
    },
  });
  const line = (lineNumber: number, productId: number, productName: string, netPrice: number) =>
    prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber,
        productId,
        productName,
        orderedQuantity: 1,
        netPrice,
        cost: netPrice / 2,
        vatRate: 0,
        vatAmount: 0,
      },
    });
  await line(1, sofa.id, "Sofa", 500);
  const chairLine = await line(2, chair.id, "Chair", 400);

  // Through the real route, so the rows are exactly what replacing leaves behind.
  const replaced = await call(
    lineRoute as Route,
    "PUT",
    { id: String(order.id), lineItemId: String(chairLine.id) },
    {
      action: "replace",
      reason: "Customer reselection",
      replacement: { productName: "Chair", productId: chair.id },
    },
  );
  expect(replaced.status).toBe(200);
  return { order, buyer, chairLine };
}

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, appName: "Holt", timezone: "America/New_York" },
  });
  invalidateAppSettingsCache();
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.user.create({ data: { id: "boss", email: "boss@example.com" } });
  await prisma.staffMember.create({
    data: {
      userId: "boss",
      email: "boss@example.com",
      displayName: "boss",
      role: "ADMIN",
      roleId: role.id,
      defaultStore: "Main Street",
    },
  });
});

describe("a replaced line counts once", () => {
  it("leaves the order with the old line replaced and a new one carrying it", async () => {
    const { order, chairLine } = await sellAndReplace();
    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrderId: order.id },
      orderBy: { id: "asc" },
    });
    expect(lines.map((l) => [l.lineItemStatus, Number(l.netPrice)])).toEqual([
      ["ACTIVE", 500],
      ["REPLACED", 400],
      ["ACTIVE", 400],
    ]);
    expect(lines[1].id).toBe(chairLine.id);
  });

  it("on the order screen's totals", async () => {
    const { order } = await sellAndReplace();
    const res = await call(orderRoute as Route, "GET", { id: String(order.id) });
    expect(res.status).toBe(200);
    expect(Number(res.body.totalAmount)).toBe(900);
  });

  it("in Detailed Sales, a Prisma report", async () => {
    await sellAndReplace();
    const rows = await getDetailedSales(prisma, { startDate: DAY, endDate: DAY });
    expect(rows.reduce((sum, r) => sum + r.netSales, 0)).toBe(900);
    expect(rows.reduce((sum, r) => sum + r.itemCount, 0)).toBe(2);
  });

  it("in Daily Sales", async () => {
    await sellAndReplace();
    const rows = await getSalesDaily(prisma, { startDate: DAY, endDate: DAY });
    expect(rows.reduce((sum, r) => sum + r.totalSales, 0)).toBe(900);
  });

  it("in Gross Margin, a raw-SQL report", async () => {
    await sellAndReplace();
    const result = await getGrossMargin(prisma, { startDate: DAY, endDate: DAY });
    expect(result.totals.revenue).toBe(900);
  });

  it("in Top Sellers, another raw-SQL report", async () => {
    await sellAndReplace();
    const result = await getTopSellers(prisma, { startDate: DAY, endDate: DAY, limit: 10 });
    const chairs = result.top.filter((r) => r.name === "Chair");
    expect(chairs.reduce((sum, r) => sum + r.revenue, 0)).toBe(400);
    expect(chairs.reduce((sum, r) => sum + r.units, 0)).toBe(1);
  });

  it("in a customer's lifetime spend, from a query built as text", async () => {
    const { buyer } = await sellAndReplace();
    await recalculateCustomerLevels();
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(Number(customer.lifetimeSpend)).toBe(900);
  });

  it("in the customer's ledger balance", async () => {
    const { order } = await sellAndReplace();
    const withLines = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lineItems: true, payments: true },
    });
    expect(computeSourceBalance([withLines as never])).toBe(900);
  });
});

describe("a replaced line itself", () => {
  it("can't be replaced or changed again, which would put the item on twice", async () => {
    const { order, chairLine } = await sellAndReplace();
    const query = { id: String(order.id), lineItemId: String(chairLine.id) };
    const again = await call(lineRoute as Route, "PUT", query, {
      action: "replace",
      reason: "Again",
      replacement: { productName: "Stool" },
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toContain("was replaced");
    const cancelled = await call(lineRoute as Route, "PUT", query, {
      action: "cancel",
      reason: "x",
    });
    expect(cancelled.status).toBe(400);
    expect(await prisma.orderLineItem.count({ where: { salesOrderId: order.id } })).toBe(3);
  });
});
