// /app/__tests__/integration/splitShare.integration.test.ts
//
// GAP-07: a split sale's shares are chosen, not fixed at 50/50.
//
// Before: `splitWithId ? 0.5 : 1` was written into eight places -- commission's
// two sums, the designer dashboard (twice), monthly performance, salesperson
// detail, the pay-period statement and Sales by Salesperson. A store that split
// 60/40 could not be represented at all, and every report agreed with every
// other while being wrong. A split could also only be added after the sale, by
// a manager on the order page.
//
// Now the order records the salesperson's share (SalesOrder.splitPercent), the
// partner gets the rest, a new split starts at the store's default
// (AppSettings.defaultSplitPercent), and every report credits each person their
// share through lib/commissionSplit.ts. The register and the quote builder can
// split a sale for those with "Reassign salesperson".
//
// Real routes and database; next-auth's session is the only mock.

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
import { loadDesignerSaleRows, sumDesignerSales } from "@/lib/commissionSales";
import { getMonthlyPerformance } from "@/lib/reports/monthlyPerformance";
import { getSalespersonDetail } from "@/lib/reports/salespersonDetail";
import { getDesignerDashboard } from "@/lib/reports/designerDashboard";
import { getPayPeriodSales } from "@/lib/reports/payPeriodSales";
import {
  getSalesBySalesperson,
  getSalesBySalespersonItems,
} from "@/lib/reports/salesBySalespersonReport";
import settingsRoute from "@/pages/api/admin/settings/index";
import salespersonRoute from "@/pages/api/sales/orders/[id]/salesperson";
import bulkRoute from "@/pages/api/admin/sales/bulk-update-salesperson";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";

const sessionMock = getServerSession as jest.Mock;
const owner = { user: { id: "owner", email: "owner@example.com" } } as unknown as Session;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
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
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  return res as unknown as TestRes;
}

function req(method: string, query: Record<string, string> = {}, body?: unknown) {
  return { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
}

/** A route called through its gate, signed in as the owner (ADMIN). */
async function gated(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
) {
  const res = makeRes();
  await route(req(method, query, body), res);
  return res;
}

const SPLIT_ON = new Date("2026-03-10T15:00:00Z");
const YEAR = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") };

async function staff(displayName: string, data: Record<string, unknown> = {}) {
  return prisma.staffMember.create({
    data: { displayName, isDesigner: true, isActive: true, ...data },
  });
}

/** An order of one line at this price. */
async function order(orderno: string, netPrice: number, data: Record<string, unknown>) {
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: SPLIT_ON,
      storeLocation: "Main Street",
      ...data,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Sofa",
            orderedQuantity: 1,
            netPrice,
            cost: netPrice / 2,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
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

describe("every report credits each person their share of a split sale", () => {
  /**
   * Ana sold a $1,000 sofa split 60/40 with Ben, a $500 one alone, and a $100
   * one the register recorded under her name only, split 70/30 with Ben. Ana is
   * credited 600 + 500 + 70 = 1,170 and Ben 400 + 30 = 430: together, the
   * $1,600 sold.
   */
  async function world() {
    const ana = await staff("Ana Primary");
    const ben = await staff("Ben Partner");
    await order("SO-SPLIT-1", 1000, {
      salesPersonId: ana.id,
      salesperson: ana.displayName,
      splitWithId: ben.id,
      splitPercent: 60,
    });
    await order("SO-ALONE", 500, { salesPersonId: ana.id, salesperson: ana.displayName });
    await order("SO-SPLIT-NAME", 100, {
      salesperson: ana.displayName,
      splitWithId: ben.id,
      splitPercent: 70,
    });
    return { ana, ben };
  }

  it("commission's sum and rows", async () => {
    const { ana, ben } = await world();
    const sum = (s: { id: number; displayName: string }) =>
      sumDesignerSales(s.id, [s.displayName], YEAR.start, YEAR.end, "WRITTEN");
    expect([await sum(ana), await sum(ben)]).toEqual([1170, 430]);

    const rows = async (s: { id: number; displayName: string }) =>
      (await loadDesignerSaleRows(s.id, [s.displayName], YEAR.start, YEAR.end, "WRITTEN")).reduce(
        (t, r) => t + r.revenue,
        0,
      );
    expect([await rows(ana), await rows(ben)]).toEqual([1170, 430]);
  });

  it("monthly performance, salesperson detail and the designer dashboard", async () => {
    const { ana, ben } = await world();
    for (const [s, credited] of [
      [ana, 1170],
      [ben, 430],
    ] as const) {
      const monthly = await getMonthlyPerformance(prisma, {
        salesperson: s.displayName,
        year: 2026,
      });
      const detail = await getSalespersonDetail(prisma, {
        salesperson: s.displayName,
        year: 2026,
      });
      const dashboard = await getDesignerDashboard(prisma, {
        salesperson: s.displayName,
        asOf: "2026-03-20",
      });
      const total = dashboard.sales.rows.find((r) => r.isTotal)!;
      expect([monthly.totals.sales, detail.ytdTotal, total.ytdValue]).toEqual([
        credited,
        credited,
        credited,
      ]);
    }
  });

  it("the dashboard's house-call follow-ups count the designer's share", async () => {
    // A house call (a DC250 line) for a customer, then a $2,000 sale to them
    // split 60/40: Ana's follow-up is worth $1,200, over the $1,000 that makes
    // it a conversion.
    const ana = await staff("Ana Primary");
    const ben = await staff("Ben Partner");
    const customer = await prisma.customer.create({
      data: { firstName: "Cora", lastName: "Call" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-HC",
        status: "ORDER",
        orderDate: new Date("2026-03-02T15:00:00Z"),
        customerId: customer.id,
        salesPersonId: ana.id,
        salesperson: ana.displayName,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "DC250",
              productName: "House call",
              orderedQuantity: 1,
              netPrice: 0,
              cost: 0,
            },
          ],
        },
      },
    });
    await order("SO-AFTER-HC", 2000, {
      customerId: customer.id,
      salesPersonId: ana.id,
      salesperson: ana.displayName,
      splitWithId: ben.id,
      splitPercent: 60,
    });
    const dashboard = await getDesignerDashboard(prisma, {
      salesperson: ana.displayName,
      asOf: "2026-03-20",
    });
    expect([dashboard.houseCalls.convertedCount, dashboard.houseCalls.avgQuoteValue]).toEqual([
      1, 1200,
    ]);
  });

  it("the pay-period statement shows each order at the designer's share", async () => {
    const { ana, ben } = await world();
    const statement = async (staffMemberId: number) =>
      getPayPeriodSales(prisma, { staffMemberId, periodStart: "2026-03-09" });
    const a = await statement(ana.id);
    const b = await statement(ben.id);
    const lines = (s: typeof a) =>
      s.orders.map((o) => [o.orderNumber, o.creditedNet, o.sharePercent]).sort();
    expect(lines(a)).toEqual([
      ["SO-ALONE", 500, null],
      ["SO-SPLIT-1", 600, 60],
      ["SO-SPLIT-NAME", 70, 70],
    ]);
    expect(lines(b)).toEqual([
      ["SO-SPLIT-1", 400, 40],
      ["SO-SPLIT-NAME", 30, 30],
    ]);
    expect([a.periodTotal, b.periodTotal]).toEqual([1170, 430]);
  });

  it("Sales by Salesperson, and its drill-down into the partner", async () => {
    const { ana, ben } = await world();
    const auth = { role: "ADMIN", userId: "owner" };
    const report = await getSalesBySalesperson(prisma, {
      auth,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    const retail = (key: string) => report.rows.find((r) => r.groupKey === key)?.retail;
    expect([retail(`sp-${ana.id}`), retail(`sp-${ben.id}`), report.total.retail]).toEqual([
      1170, 430, 1600,
    ]);

    const items = await getSalesBySalespersonItems(prisma, {
      auth,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      groupKey: `sp-${ben.id}`,
    });
    expect(items.map((i) => [i.orderno, i.retail, i.cost]).sort()).toEqual([
      ["SO-SPLIT-1", 400, 200],
      ["SO-SPLIT-NAME", 30, 15],
    ]);
  });
});

describe("the store's default share", () => {
  it("is set in Settings, 1 to 99", async () => {
    const saved = await gated(settingsRoute, "PUT", {}, { defaultSplitPercent: 60 });
    expect(saved.statusCode).toBe(200);
    expect(
      (await prisma.appSettings.findFirstOrThrow({ select: { defaultSplitPercent: true } }))
        .defaultSplitPercent,
    ).toBe(60);
    for (const bad of [0, 100, 50.5, "60"]) {
      const res = await gated(settingsRoute, "PUT", {}, { defaultSplitPercent: bad });
      expect([bad, res.statusCode]).toEqual([bad, 400]);
    }
  });

  it("the database refuses a share outside 1-99", async () => {
    const ben = await staff("Ben Partner");
    await expect(
      order("SO-BAD", 100, { salesperson: "X", splitWithId: ben.id, splitPercent: 100 }),
    ).rejects.toThrow(/SalesOrder_splitPercent_range/);
  });
});

describe("splitting a sale at the register or on a quote", () => {
  async function cartWorld() {
    await prisma.appSettings.updateMany({ data: { defaultSplitPercent: 60 } });
    invalidateAppSettingsCache();
    const store = await prisma.storeLocation.create({
      data: { name: "Main Street", code: "MS", type: "STORE" },
    });
    const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
    const department = await prisma.department.create({ data: { name: "Living" } });
    const category = await prisma.category.create({
      data: { name: "Sofas", departmentId: department.id },
    });
    const sofa = await prisma.product.create({
      data: {
        productNumber: "SOFA-1",
        name: "Sofa",
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseRetail: 1000,
        baseCost: 500,
      },
    });
    return { store, sofa, ben: await staff("Ben Partner", { email: "ben@example.com" }) };
  }

  async function ring(
    w: Awaited<ReturnType<typeof cartWorld>>,
    split: Record<string, unknown>,
    holdsReassign = true,
  ) {
    const res = makeRes();
    await createFromCart(
      req(
        "POST",
        {},
        {
          storeLocation: w.store.name,
          items: [{ productId: w.sofa.id, quantity: 1, unitPrice: 1000 }],
          ...split,
        },
      ),
      res,
      owner,
      { holds: { "sales.reassign": holdsReassign } },
    );
    return res;
  }

  it("records the partner and the share: the store's default, or the one chosen", async () => {
    const w = await cartWorld();
    const byDefault = await ring(w, { splitWithId: w.ben.id });
    const chosen = await ring(w, { splitWithId: w.ben.id, splitPercent: 75 });
    const unsplit = await ring(w, {});
    const split = (id: number) =>
      prisma.salesOrder.findUniqueOrThrow({
        where: { id },
        select: { splitWithId: true, splitPercent: true },
      });
    expect(await split(byDefault.body.id)).toEqual({ splitWithId: w.ben.id, splitPercent: 60 });
    expect(await split(chosen.body.id)).toEqual({ splitWithId: w.ben.id, splitPercent: 75 });
    expect((await split(unsplit.body.id)).splitWithId).toBeNull();
  });

  it("takes Reassign salesperson, and refuses a share or partner that can't be", async () => {
    const w = await cartWorld();
    const retired = await staff("Old Hand", { isActive: false });
    const owner = await prisma.staffMember.findFirstOrThrow({ where: { userId: "owner" } });
    const cases: [Record<string, unknown>, boolean, number, RegExp][] = [
      [{ splitWithId: w.ben.id }, false, 403, /Reassign salesperson/],
      [{ splitWithId: w.ben.id, splitPercent: 100 }, true, 400, /1 to 99/],
      [{ splitWithId: w.ben.id, splitPercent: 0 }, true, 400, /1 to 99/],
      [{ splitPercent: 60 }, true, 400, /someone to split/],
      [{ splitWithId: retired.id }, true, 400, /no longer works here/],
      [{ splitWithId: owner.id }, true, 400, /person selling it/],
      [{ splitWithId: 99999 }, true, 400, /isn't on the staff/],
    ];
    for (const [split, holds, status, message] of cases) {
      const res = await ring(w, split, holds);
      expect([split, res.statusCode, res.body.error]).toEqual([
        split,
        status,
        expect.stringMatching(message),
      ]);
    }
    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("changing a split on the order", () => {
  async function orderWorld() {
    await prisma.appSettings.updateMany({ data: { defaultSplitPercent: 60 } });
    invalidateAppSettingsCache();
    const ana = await staff("Ana Primary");
    const ben = await staff("Ben Partner");
    const cal = await staff("Cal Third");
    const o = await order("SO-CHANGE", 1000, {
      salesPersonId: ana.id,
      salesperson: ana.displayName,
    });
    return { ana, ben, cal, id: String(o.id) };
  }

  const shareOf = async (id: string) =>
    (
      await prisma.salesOrder.findUniqueOrThrow({
        where: { id: Number(id) },
        select: { splitWithId: true, splitPercent: true },
      })
    ).splitPercent;

  it("a new split takes the store's default; a new partner keeps the share; a share can be chosen", async () => {
    const w = await orderWorld();
    const put = (body: Record<string, unknown>) =>
      gated(salespersonRoute, "PUT", { id: w.id }, { salesPersonId: w.ana.id, ...body });

    expect((await put({ splitWithId: w.ben.id })).body.splitPercent).toBe(60);
    expect((await put({ splitWithId: w.ben.id, splitPercent: 75 })).body.splitPercent).toBe(75);
    expect((await put({ splitWithId: w.cal.id })).body.splitPercent).toBe(75);
    expect(await shareOf(w.id)).toBe(75);

    const logs = await prisma.orderChangeLog.findMany({
      where: { salesOrderId: Number(w.id), changeType: "SALESPERSON_CHANGE" },
      orderBy: { id: "asc" },
    });
    expect(logs.map((l) => l.newValue)).toEqual([
      "Ana Primary, split 60/40 with Ben Partner",
      "Ana Primary, split 75/25 with Ben Partner",
      "Ana Primary, split 75/25 with Cal Third",
    ]);

    const bad = await put({ splitWithId: w.ben.id, splitPercent: 100 });
    expect([bad.statusCode, await shareOf(w.id)]).toEqual([400, 75]);
  });

  it("a confirmed pay period refuses a change of share too", async () => {
    const w = await orderWorld();
    await gated(
      salespersonRoute,
      "PUT",
      { id: w.id },
      { salesPersonId: w.ana.id, splitWithId: w.ben.id },
    );
    await prisma.payPeriodConfirmation.create({
      data: {
        staffMemberId: w.ben.id,
        periodStart: new Date("2026-03-09T00:00:00Z"),
        periodEnd: new Date("2026-03-22T23:59:59Z"),
        confirmedBy: "ben@example.com",
      },
    });
    const res = await gated(
      salespersonRoute,
      "PUT",
      { id: w.id },
      { salesPersonId: w.ana.id, splitWithId: w.ben.id, splitPercent: 80 },
    );
    expect([res.statusCode, await shareOf(w.id)]).toEqual([409, 60]);
  });

  it("the bulk corrections keep, set and refuse shares the same way", async () => {
    const w = await orderWorld();
    const res = await gated(
      bulkRoute,
      "POST",
      {},
      {
        updates: [{ orderId: Number(w.id), salesPersonId: w.ana.id, splitWithId: w.ben.id }],
      },
    );
    expect([res.body.updated, await shareOf(w.id)]).toEqual([1, 60]);

    const chosen = await gated(
      bulkRoute,
      "POST",
      {},
      {
        updates: [
          {
            orderId: Number(w.id),
            salesPersonId: w.ana.id,
            splitWithId: w.ben.id,
            splitPercent: 80,
          },
        ],
      },
    );
    expect([chosen.body.updated, await shareOf(w.id)]).toEqual([1, 80]);

    const refused = await gated(
      bulkRoute,
      "POST",
      {},
      {
        updates: [
          {
            orderId: Number(w.id),
            salesPersonId: w.ana.id,
            splitWithId: w.ben.id,
            splitPercent: 0,
          },
        ],
      },
    );
    expect([refused.body.updated, refused.body.errors[0].reason, await shareOf(w.id)]).toEqual([
      0,
      expect.stringMatching(/1 to 99/),
      80,
    ]);
  });
});
