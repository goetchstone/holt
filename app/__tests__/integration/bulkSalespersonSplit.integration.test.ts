// /app/__tests__/integration/bulkSalespersonSplit.integration.test.ts
//
// Salesperson Corrections must not wipe a split it was not asked to touch.
// The screen's "No change" sent splitWithId: undefined, which JSON drops, and
// the route read the missing key as `row.splitWithId ?? null`: every order a
// manager reassigned lost its split partner, and the partner lost their share
// of the commission. Absent now keeps the order's split; only an explicit null
// removes it.
//
// Real route and database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import bulkRoute from "@/pages/api/admin/sales/bulk-update-salesperson";
import { KEPT_SPLIT_IS_NEW_SALESPERSON } from "@/lib/sales/bulkSalespersonShared";

const sessionMock = getServerSession as jest.Mock;
const owner = { user: { id: "owner", email: "owner@example.com" } } as unknown as Session;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: { updated: number; errors: { orderId: number; reason: string }[] };
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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
  return res as unknown as TestRes;
}

async function bulk(updates: unknown[]) {
  const res = makeRes();
  await bulkRoute(
    {
      method: "POST",
      query: {},
      body: { updates },
      cookies: {},
      headers: {},
    } as unknown as NextApiRequest,
    res,
  );
  return res;
}

async function world() {
  const [ana, ben, cal] = await Promise.all(
    ["Ana", "Ben", "Cal"].map((displayName) =>
      prisma.staffMember.create({ data: { displayName, isDesigner: true, isActive: true } }),
    ),
  );
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "TST-1",
      status: "ORDER",
      orderDate: new Date("2026-03-10T15:00:00Z"),
      salesperson: "Ana",
      salesPersonId: ana.id,
      splitWithId: ben.id,
      splitPercent: 60,
    },
  });
  return { ana, ben, cal, order };
}

function split(orderId: number) {
  return prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { salesPersonId: true, salesperson: true, splitWithId: true, splitPercent: true },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: {
      userId: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      role: "ADMIN",
      roleId: role.id,
    },
  });
  sessionMock.mockResolvedValue(owner);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("bulk salesperson correction and an order's split", () => {
  it("keeps the split, partner and share when the split is left out of the row", async () => {
    const w = await world();
    // What the screen sends for "Keep each order's split": no splitWithId key.
    const res = await bulk([{ orderId: w.order.id, salesPersonId: w.cal.id }]);

    expect(res.body).toEqual({ updated: 1, errors: [] });
    expect(await split(w.order.id)).toEqual({
      salesPersonId: w.cal.id,
      salesperson: "Cal",
      splitWithId: w.ben.id,
      splitPercent: 60,
    });
    // The change log records the reassignment and the split it kept.
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: w.order.id, changeType: "SALESPERSON_CHANGE" },
    });
    expect(log.previousValue).toBe("Ana, split with Ben");
    expect(log.newValue).toBe("Cal, split with Ben");
    expect(log.reason).toBe("Bulk salesperson correction");
  });

  it("removes the split only on an explicit null", async () => {
    const w = await world();
    const res = await bulk([{ orderId: w.order.id, salesPersonId: w.cal.id, splitWithId: null }]);

    expect(res.body).toEqual({ updated: 1, errors: [] });
    expect(await split(w.order.id)).toMatchObject({ salesPersonId: w.cal.id, splitWithId: null });
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: w.order.id, changeType: "SALESPERSON_CHANGE" },
    });
    expect(log.newValue).toBe("Cal");
  });

  it("refuses to make the kept split partner the salesperson too", async () => {
    const w = await world();
    const res = await bulk([{ orderId: w.order.id, salesPersonId: w.ben.id }]);

    expect(res.body.updated).toBe(0);
    // The reason names the screen's choice that resolves it, so the manager
    // can act on the refused order rather than read "1 failed".
    expect(res.body.errors).toEqual([
      { orderId: w.order.id, reason: KEPT_SPLIT_IS_NEW_SALESPERSON },
    ]);
    expect(KEPT_SPLIT_IS_NEW_SALESPERSON).toContain('"No split (remove it)"');
    expect(await split(w.order.id)).toMatchObject({
      salesPersonId: w.ana.id,
      splitWithId: w.ben.id,
    });
    expect(await prisma.orderChangeLog.count({ where: { salesOrderId: w.order.id } })).toBe(0);
  });

  it("refuses a row that names the same person as salesperson and split", async () => {
    const w = await world();
    const res = await bulk([
      { orderId: w.order.id, salesPersonId: w.cal.id, splitWithId: w.cal.id },
    ]);

    expect(res.body).toEqual({
      updated: 0,
      errors: [{ orderId: w.order.id, reason: "Primary and split are the same" }],
    });
  });

  it("writes nothing when the row changes nothing", async () => {
    const w = await world();
    const res = await bulk([{ orderId: w.order.id, salesPersonId: w.ana.id }]);

    expect(res.body).toEqual({ updated: 0, errors: [] });
    expect(await prisma.orderChangeLog.count({ where: { salesOrderId: w.order.id } })).toBe(0);
  });
});
