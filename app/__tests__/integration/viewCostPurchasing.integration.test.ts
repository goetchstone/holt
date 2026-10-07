// /app/__tests__/integration/viewCostPurchasing.integration.test.ts
//
// "View cost" (catalog.cost, SEC-14) over purchase-order cost: the purchase
// order list's totals, the detail page's unit costs, line totals and receipt
// costs, the receiving records' cost and the inbound dashboard's totals. Each
// route still serves everyone its own key admits; a caller without View cost
// gets the same orders without cost (strip, never deny).
//
// Real routes, real gates, real database; next-auth's session is the only mock.

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
import ordersRoute from "@/pages/api/purchasing/orders/index";
import orderRoute from "@/pages/api/purchasing/orders/[id]";
import receivingRoute from "@/pages/api/purchasing/receiving/index";
import inboundRoute from "@/pages/api/warehouse/inbound-dashboard";
import { appRouter } from "@/server/trpc/routers/_app";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      payload = p;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await route({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) };
}

/** Every key at every depth that carries cost (the visibility flag excepted). */
function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost|lineTotal/i.test(k) && k !== "costVisible" ? [k] : []),
      ...costKeys(v),
    ]);
  }
  return [];
}

async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
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

const w: Record<string, { id: number }> = {};

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  await makeStaff("mia", "MANAGER");
  // A custom role that runs receiving and reads orders, without View cost.
  await prisma.role.create({
    data: {
      key: "RECEIVER",
      name: "Receiver",
      isSystem: false,
      permissions: {
        create: ["purchasing.read", "purchasing.receive"].map((permission) => ({ permission })),
      },
    },
  });
  await makeStaff("rae", "RECEIVER", "DESIGNER");

  const vendor = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
  w.po = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-COST-1",
      vendorId: vendor.id,
      status: "CONFIRMED",
      orderDate: new Date("2026-09-20T15:00:00Z"),
      expectedDelivery: new Date("2026-10-10T15:00:00Z"),
      notes: "first",
    },
  });
  const item = await prisma.purchaseOrderItem.create({
    data: {
      purchaseOrderId: w.po.id,
      partNo: "QH-1",
      productName: "Quarry Sofa",
      orderedQuantity: 2,
      unitCost: 400,
    },
  });
  await prisma.receivingRecord.create({
    data: {
      purchaseOrderId: w.po.id,
      purchaseOrderItemId: item.id,
      receiverUserId: "mia",
      quantityReceived: 1,
      lineCost: 400,
      receivedDate: new Date("2026-09-28T15:00:00Z"),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ROUTES: Array<[string, Route, object]> = [
  ["purchase order list", ordersRoute, {}],
  ["purchase order detail", orderRoute, { query: { id: "1" } }],
  ["receiving records", receivingRoute, {}],
  ["inbound dashboard", inboundRoute, {}],
];

describe("purchase-order cost follows View cost", () => {
  it.each(ROUTES)("%s: a holder gets the cost", async (_name, route, opts) => {
    const { status, body } = await call(route, "mia", opts);
    expect(status).toBe(200);
    expect(body.costVisible).toBe(true);
    expect(costKeys(body).length).toBeGreaterThan(0);
  });

  it.each(ROUTES)(
    "%s: a role without View cost gets the same orders without cost, not a refusal",
    async (_name, route, opts) => {
      const { status, body } = await call(route, "rae", opts);
      expect(status).toBe(200);
      expect(body.costVisible).toBe(false);
      expect(costKeys(body)).toEqual([]);
    },
  );

  it("the figures a holder sees are the order's", async () => {
    const detail = (await call(orderRoute, "mia", { query: { id: String(w.po.id) } })).body;
    expect(detail.lineItems[0]).toMatchObject({ unitCost: 400, lineTotal: 800 });
    expect(detail.lineItems[0].receivingRecords[0].lineCost).toBe(400);
    const list = (await call(ordersRoute, "mia")).body;
    expect(list.orders[0].totalCost).toBe(800);
  });

  it("a role without View cost keeps everything else on the order, and its edits leave cost alone", async () => {
    const { body } = await call(orderRoute, "rae", { query: { id: String(w.po.id) } });
    expect(body.lineItems[0]).toMatchObject({
      productName: "Quarry Sofa",
      orderedQuantity: 2,
      totalReceived: 1,
    });

    const put = await call(orderRoute, "rae", {
      method: "PUT",
      query: { id: String(w.po.id) },
      body: { notes: "edited without cost on screen" },
    });
    expect(put.status).toBe(200);
    const stored = await prisma.purchaseOrderItem.findFirstOrThrow({
      where: { purchaseOrderId: w.po.id },
    });
    expect(Number(stored.unitCost)).toBe(400);
  });
});

describe("the open-orders procedure nothing called", () => {
  it("is gone: on REPORT_ROLES, which names DESIGNER, it gave every custom role all open PO totals", () => {
    expect(Object.keys(appRouter._def.procedures)).not.toContain("reports.openOrders");
    expect(Object.keys(appRouter._def.procedures)).toContain("reports.departments");
  });
});
