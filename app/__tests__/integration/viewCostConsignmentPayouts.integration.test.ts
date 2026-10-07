// /app/__tests__/integration/viewCostConsignmentPayouts.integration.test.ts
//
// "View cost" (catalog.cost, SEC-14) over consignor payouts: payment batches,
// PO Management (unassigned sold rugs, assign-to-batch, apply-credits), unpaid
// sales, credits owed and the Consignment Summary report. Each keeps its own
// gate and audience; a caller without View cost gets counts and rugs without
// amounts (strip, never deny), and can still create a batch and apply credits:
// the totals are computed on the server from stored cost, never sent.
//
// Real routes, real gates, real database; the session readers are the only mocks.

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
import { getConsignmentSummary } from "@/lib/reports/consignmentSummary";
import ConsignmentReportPage from "@/app/(dashboard)/app/reports/consignment-report/page";
import paymentsRoute from "@/pages/api/consignment/payments/index";
import paymentRoute from "@/pages/api/consignment/payments/[id]";
import unpaidRoute from "@/pages/api/consignment/unpaid-sales";
import creditsRoute from "@/pages/api/consignment/credits-owed";
import unassignedRoute from "@/pages/api/consignment/po-management/unassigned-sold";
import assignRoute from "@/pages/api/consignment/po-management/assign-to-batch";
import applyRoute from "@/pages/api/consignment/po-management/apply-credits";

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
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Every key at every depth that carries a cost or an amount owed or paid
 * (totalAmount, totalCredit, soldTotal, netTotal, soldValue, totalCost...), but
 * not a count (total, totalItems) or the visibility flag.
 */
function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost|amount|totalcredit|.total$|value$/i.test(k) && k !== "costVisible" ? [k] : []),
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

async function seedRugs() {
  const vendor = await prisma.vendor.create({ data: { name: "Kilim House" } });
  w.vendor = vendor;
  const rug = (barcode: string, cost: number, extra: object) =>
    prisma.consignmentItem.create({
      data: {
        vendorId: vendor.id,
        barcode,
        cost,
        anchorPrice: cost * 7,
        retailPrice: cost * 3.5,
        ...extra,
      },
    });
  w.batch = await prisma.consignmentPaymentBatch.create({
    data: {
      vendorId: vendor.id,
      periodStart: new Date("2026-08-01"),
      periodEnd: new Date("2026-08-31"),
      totalAmount: 500,
      itemCount: 3,
      checkNumber: "2001",
    },
  });
  w.sold1 = await rug("SOLD-1", 100, { status: "SOLD", saleDate: new Date("2026-09-10") });
  w.sold2 = await rug("SOLD-2", 50, { status: "SOLD", saleDate: new Date("2026-09-12") });
  // Paid on the August batch, then returned by the customer: the store is owed its cost back.
  w.credit = await rug("CREDIT-1", 30, {
    status: "ON_FLOOR",
    creditOwed: true,
    consignmentPaymentBatchId: w.batch.id,
    paidDate: new Date("2026-08-20"),
  });
}

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  // A holder, and an ADMIN whose View cost the owner has unticked (ADMIN also
  // passes the Consignment Summary's ["ADMIN"] page list).
  await makeStaff("mia", "MANAGER");
  await makeStaff("ada", "ADMIN");
  await makeStaff("sam", "SUPER_ADMIN");
  const admin = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.rolePermission.deleteMany({
    where: { roleId: admin.id, permission: "catalog.cost" },
  });
  await prisma.role.update({ where: { id: admin.id }, data: { grantsCustomized: true } });
  invalidateRoleGrantCache();
  await seedRugs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ROUTES: Array<[string, Route, () => object]> = [
  ["payment batches", paymentsRoute, () => ({})],
  ["one payment batch", paymentRoute, () => ({ query: { id: String(w.batch.id) } })],
  ["unpaid sales", unpaidRoute, () => ({})],
  ["credits owed", creditsRoute, () => ({})],
  ["PO Management sold rugs", unassignedRoute, () => ({})],
];

describe("consignor payouts follow View cost", () => {
  it.each(ROUTES)("%s: a holder gets the amounts", async (_name, route, opts) => {
    const { status, body } = await call(route, "mia", opts());
    expect(status).toBe(200);
    expect(body.costVisible).toBe(true);
    expect(costKeys(body).length).toBeGreaterThan(0);
  });

  it.each(ROUTES)(
    "%s: an admin with View cost unticked gets the same rugs and counts without amounts",
    async (_name, route, opts) => {
      const { status, body } = await call(route, "ada", opts());
      expect(status).toBe(200);
      expect(body.costVisible).toBe(false);
      expect(costKeys(body)).toEqual([]);
      // Stripped, not denied: the same rows a holder gets.
      const holder = (await call(route, "mia", opts())).body;
      const ids = (b: { items?: { id: number }[]; batches?: { id: number }[] }) =>
        (b.items ?? b.batches ?? []).map((r) => r.id);
      expect(ids(body).length).toBeGreaterThan(0);
      expect(ids(body)).toEqual(ids(holder));
    },
  );

  it("the figures a holder sees are the rugs' and the batch's", async () => {
    expect((await call(creditsRoute, "mia")).body.totalCredit).toBe(30);
    const batch = (await call(paymentRoute, "mia", { query: { id: String(w.batch.id) } })).body;
    expect(batch.totalAmount).toBe(500);
    const unpaid = (await call(unpaidRoute, "mia")).body.items;
    expect(unpaid.map((i: { cost: number }) => i.cost)).toEqual([100, 50]);
  });
});

describe("a caller without View cost can still pay the consignor", () => {
  it("creates a batch whose stored total is computed from stored cost, and sees only counts", async () => {
    const created = await call(assignRoute, "ada", {
      method: "POST",
      body: { consignmentItemIds: [w.sold1.id, w.sold2.id], creditItemIds: [w.credit.id] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      batchId: expect.any(Number),
      soldCount: 2,
      creditCount: 1,
      costVisible: false,
    });
    const stored = await prisma.consignmentPaymentBatch.findUniqueOrThrow({
      where: { id: created.body.batchId },
    });
    expect(Number(stored.totalAmount)).toBe(120); // 100 + 50 - 30
  });

  it("applies credits to an existing batch, and sees only the count", async () => {
    const extra = await prisma.consignmentItem.create({
      data: {
        vendorId: w.vendor.id,
        barcode: "CREDIT-2",
        cost: 40,
        status: "ON_FLOOR",
        creditOwed: true,
        paidDate: new Date("2026-08-25"),
      },
    });
    const applied = await call(applyRoute, "ada", {
      method: "POST",
      body: { creditItemIds: [extra.id], batchId: w.batch.id },
    });
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ batchId: w.batch.id, creditCount: 1, costVisible: false });
    const stored = await prisma.consignmentPaymentBatch.findUniqueOrThrow({
      where: { id: w.batch.id },
    });
    expect(Number(stored.totalAmount)).toBe(460); // 500 - 40
  });
});

describe("a batch created or edited on the Payments screen follows View cost", () => {
  async function soldRug(barcode: string, cost: number, saleDate: string) {
    await prisma.consignmentItem.create({
      data: { vendorId: w.vendor.id, barcode, cost, status: "SOLD", saleDate: new Date(saleDate) },
    });
  }

  it("a caller without View cost creates a batch for a period and sees no total", async () => {
    await soldRug("OCT-1", 70, "2026-10-05");
    const created = await call(paymentsRoute, "ada", {
      method: "POST",
      body: {
        vendorId: w.vendor.id,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        checkNumber: "3001",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ itemCount: 1, costVisible: false });
    expect(costKeys(created.body)).toEqual([]);
    const stored = await prisma.consignmentPaymentBatch.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(Number(stored.totalAmount)).toBe(70);
  });

  it("a holder creates one and sees the total", async () => {
    await soldRug("NOV-1", 90, "2026-11-05");
    const created = await call(paymentsRoute, "mia", {
      method: "POST",
      body: { vendorId: w.vendor.id, periodStart: "2026-11-01", periodEnd: "2026-11-30" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ totalAmount: 90, costVisible: true });
  });

  it("editing a batch's notes answers with the total only for a holder", async () => {
    const edit = (userId: string) =>
      call(paymentRoute, userId, {
        method: "PUT",
        query: { id: String(w.batch.id) },
        body: { notes: `checked by ${userId}` },
      });
    const blind = await edit("ada");
    expect(blind.status).toBe(200);
    expect(blind.body).toMatchObject({ notes: "checked by ada", costVisible: false });
    expect(costKeys(blind.body)).toEqual([]);
    const holder = await edit("mia");
    expect(holder.body).toMatchObject({ costVisible: true, totalAmount: expect.any(Number) });
  });
});

describe("the Consignment Summary page follows View cost", () => {
  /** What the server page hands its client view, for one viewer. */
  async function pageData(userId: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: userId });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
    const element = await ConsignmentReportPage();
    return element.props.data;
  }

  it("sends the values to a holder and only counts to anyone else", async () => {
    const report = await getConsignmentSummary(prisma);

    const holder = await pageData("sam");
    expect(holder.costVisible).toBe(true);
    expect(costKeys(holder).length).toBeGreaterThan(0);

    const blind = await pageData("ada");
    expect(blind.costVisible).toBe(false);
    expect(costKeys(blind)).toEqual([]);
    expect(blind.totals.totalItems).toBe(report.totals.totalItems);
    expect(blind.statusCounts.map((s: { count: number }) => s.count)).toEqual(
      report.statusCounts.map((s) => s.count),
    );
  });
});
