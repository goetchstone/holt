// /app/__tests__/integration/customerReferrals.integration.test.ts
//
// GAP-08: the customer record.
//
//   - "Referred by" (owner, 2026-11-01: both): how a customer heard of the
//     store, from a list the store sets up in Settings, and the customer who
//     sent them. Only Lead.source had a source before.
//   - A filtered email list. Before, the only way out was the admin's full
//     Customers table export.
//
// Found on the way and fixed:
//   - POST /api/customers wrote `...req.body` into the new customer, so a
//     caller could create one holding store credit, a trade account or a tax
//     exemption.
//   - The customer edit form called PUT /api/customers/[id], which answered
//     only GET: a customer's name, email or phone could not be changed.
//
// Real routes, real database; next-auth's session is the only mock.

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
import { getReferralReport } from "@/lib/reports/referrals";
import sourcesRoute from "@/pages/api/referral-sources/index";
import { handler as sourceRoute } from "@/pages/api/referral-sources/[id]";
import customersRoute from "@/pages/api/customers/index";
import customerRoute, { handlers as customerHandlers } from "@/pages/api/customers/[id]/index";
import mergeRoute from "@/pages/api/customers/merge-duplicates";
import { handler as emailListRoute } from "@/pages/api/customers/email-list";

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

function request(method: string, query: Record<string, string>, body?: unknown): NextApiRequest {
  return { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
}

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
) {
  const res = makeRes();
  await route(request(method, query, body), res);
  return res;
}

async function source(name: string, isActive = true) {
  return prisma.referralSource.create({ data: { name, isActive } });
}

async function customer(data: Record<string, unknown> = {}) {
  return prisma.customer.create({
    data: { firstName: "Ada", lastName: `Lane${Math.random()}`, ...data },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
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
  (getServerSession as jest.Mock).mockResolvedValue(owner);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Settings › Referral sources", () => {
  it("adds, renames, switches off and deletes the store's own sources", async () => {
    const added = await call(sourcesRoute, "POST", {}, { name: "  Instagram " });
    expect([added.statusCode, added.body.name]).toEqual([201, "Instagram"]);

    const clash = await call(sourcesRoute, "POST", {}, { name: "instagram" });
    expect([clash.statusCode, clash.body.error]).toEqual([409, expect.stringMatching(/already/)]);
    const blank = await call(sourcesRoute, "POST", {}, { name: " " });
    expect(blank.statusCode).toBe(400);

    const id = String(added.body.id);
    const renamed = makeRes();
    await sourceRoute(request("PUT", { id }, { name: "Instagram ad" }), renamed, owner);
    expect(renamed.body.name).toBe("Instagram ad");

    const off = makeRes();
    await sourceRoute(request("PUT", { id }, { isActive: false }), off, owner);
    expect(off.body.isActive).toBe(false);
    expect((await call(sourcesRoute, "GET")).body).toEqual([]);
    expect((await call(sourcesRoute, "GET", { all: "1" })).body).toEqual([
      expect.objectContaining({ name: "Instagram ad", isActive: false, customerCount: 0 }),
    ]);

    const gone = makeRes();
    await sourceRoute(request("DELETE", { id }), gone, owner);
    expect(gone.statusCode).toBe(200);
    expect(await prisma.referralSource.count()).toBe(0);
  });

  it("a source customers have is switched off, not deleted", async () => {
    const s = await source("A friend");
    await customer({ referralSourceId: s.id });
    const res = makeRes();
    await sourceRoute(request("DELETE", { id: String(s.id) }), res, owner);
    expect([res.statusCode, res.body.error]).toEqual([409, expect.stringMatching(/Switch it off/)]);
  });
});

describe("creating a customer", () => {
  it("writes only what the form sets: contact details and how they heard of the store", async () => {
    const s = await source("A friend");
    const referrer = await customer();
    const res = await call(
      customersRoute,
      "POST",
      {},
      {
        firstName: " Grace ",
        lastName: "Hopper",
        email: "grace@example.com",
        referralSourceId: s.id,
        referredByCustomerId: referrer.id,
        // A caller can't hand itself any of these:
        creditBalance: 500,
        isTradeAccount: true,
        customerLevel: 9,
        openArBalance: -100,
      },
    );
    expect(res.statusCode).toBe(201);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: res.body.id } });
    expect({
      firstName: saved.firstName,
      credit: Number(saved.creditBalance),
      trade: saved.isTradeAccount,
      level: saved.customerLevel,
      ar: Number(saved.openArBalance),
      source: saved.referralSourceId,
      referrer: saved.referredByCustomerId,
    }).toEqual({
      firstName: "Grace",
      credit: 0,
      trade: false,
      level: null,
      ar: 0,
      source: s.id,
      referrer: referrer.id,
    });
  });

  it("refuses, saying why: nothing to know them by, a duplicate email, an off source, a missing referrer", async () => {
    const off = await source("Spring catalog", false);
    await customer({ email: "taken@example.com" });
    const cases: [unknown, number, RegExp][] = [
      [{ firstName: " " }, 400, /name or an email/],
      [{ lastName: "Lane", email: "taken@example.com" }, 409, /already has that email/],
      [{ lastName: "Lane", email: "not-an-email" }, 400, /email address/],
      [{ lastName: "Lane", referralSourceId: off.id }, 400, /switched off/],
      [{ lastName: "Lane", referredByCustomerId: 999999 }, 400, /doesn't exist/],
      [{ lastName: "Lane", referralSourceId: "1" }, 400, /referral source id/],
    ];
    for (const [body, status, message] of cases) {
      const res = await call(customersRoute, "POST", {}, body);
      expect([res.statusCode, res.body.error]).toEqual([status, expect.stringMatching(message)]);
    }
    expect(await prisma.customer.count()).toBe(1);
  });
});

describe("editing a customer", () => {
  it("changes contact details and referral, through the gate the form uses", async () => {
    const s = await source("Search");
    const c = await customer({ email: "old@example.com", phone: "555-0100" });
    const referrer = await customer();
    const res = await call(
      customerRoute,
      "PUT",
      { id: String(c.id) },
      {
        email: "new@example.com",
        referralSourceId: s.id,
        referredByCustomerId: referrer.id,
      },
    );
    expect(res.statusCode).toBe(200);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    // What wasn't sent is left as it was.
    expect([saved.email, saved.phone, saved.referralSourceId, saved.referredByCustomerId]).toEqual([
      "new@example.com",
      "555-0100",
      s.id,
      referrer.id,
    ]);

    const cleared = await call(
      customerRoute,
      "PUT",
      { id: String(c.id) },
      { referredByCustomerId: null },
    );
    expect(cleared.body.referredByCustomerId).toBeNull();
  });

  it("keeps a switched-off source the customer already has, and offers it to nobody new", async () => {
    const s = await source("Spring catalog");
    const c = await customer({ referralSourceId: s.id });
    const other = await customer();
    await prisma.referralSource.update({ where: { id: s.id }, data: { isActive: false } });

    const keep = await call(
      customerRoute,
      "PUT",
      { id: String(c.id) },
      { referralSourceId: s.id, lastName: "Kept" },
    );
    expect(keep.statusCode).toBe(200);
    const fresh = await call(
      customerRoute,
      "PUT",
      { id: String(other.id) },
      { referralSourceId: s.id },
    );
    expect([fresh.statusCode, fresh.body.error]).toEqual([
      400,
      expect.stringMatching(/switched off/),
    ]);
  });

  it("refuses a referral to themselves, a duplicate email, and a customer that isn't there", async () => {
    const c = await customer();
    await customer({ email: "taken@example.com" });
    const self = await call(
      customerRoute,
      "PUT",
      { id: String(c.id) },
      { referredByCustomerId: c.id },
    );
    expect([self.statusCode, self.body.error]).toEqual([400, expect.stringMatching(/themselves/)]);
    const dup = await call(
      customerRoute,
      "PUT",
      { id: String(c.id) },
      { email: "taken@example.com" },
    );
    expect(dup.statusCode).toBe(409);
    const missing = await call(customerRoute, "PUT", { id: "999999" }, { lastName: "X" });
    expect(missing.statusCode).toBe(404);
  });

  it("the database refuses a customer referred by themselves", async () => {
    const c = await customer();
    await expect(
      prisma.customer.update({ where: { id: c.id }, data: { referredByCustomerId: c.id } }),
    ).rejects.toThrow();
  });

  it("the record says how they heard of the store and who sent them", async () => {
    const s = await source("Instagram");
    const referrer = await customer({ firstName: "Grace", lastName: "Hopper" });
    const c = await customer({ referralSourceId: s.id, referredByCustomerId: referrer.id });
    const res = makeRes();
    await customerHandlers.GET(request("GET", { id: String(c.id) }), res, owner);
    expect(res.body.referralSource).toMatchObject({ name: "Instagram" });
    expect(res.body.referredBy).toEqual({
      id: referrer.id,
      firstName: "Grace",
      lastName: "Hopper",
    });
  });
});

describe("merging duplicates keeps the referrals", () => {
  it("moves who the duplicate sent to the customer kept, and takes its source where the kept has none", async () => {
    const s = await source("A designer");
    const keep = await prisma.customer.create({ data: { firstName: "Sam", lastName: "Doe" } });
    await prisma.customerExternalId.create({ data: { customerId: keep.id, externalId: "EXT-1" } });
    const dupe = await prisma.customer.create({
      data: { firstName: "Sam", lastName: "Doe", referralSourceId: s.id },
    });
    const sentByDupe = await customer({ referredByCustomerId: dupe.id });
    await prisma.customer.update({
      where: { id: keep.id },
      data: { referredByCustomerId: dupe.id },
    });

    const res = await call(mergeRoute, "POST");
    expect(res.statusCode).toBe(200);
    expect(await prisma.customer.findUnique({ where: { id: dupe.id } })).toBeNull();
    const kept = await prisma.customer.findUniqueOrThrow({ where: { id: keep.id } });
    expect([kept.referralSourceId, kept.referredByCustomerId]).toEqual([s.id, null]);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: sentByDupe.id } }))
        .referredByCustomerId,
    ).toBe(keep.id);
  });
});

describe("the customer email list", () => {
  async function world() {
    const store = await prisma.storeLocation.create({
      data: { name: "Harbor", code: "HB", type: "STORE" },
    });
    const s = await source("Instagram");
    const sale = (
      customerId: number,
      status: string,
      orderDate: string,
      data: Record<string, unknown> = {},
    ) =>
      prisma.salesOrder.create({
        data: {
          orderno: `SO-${Math.random()}`,
          customerId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: status as any,
          orderDate: new Date(`${orderDate}T15:00:00Z`),
          ...data,
        },
      });
    const a = await customer({ email: "a@example.com", customerLevel: 3, referralSourceId: s.id });
    const b = await customer({ email: "b@example.com", customerLevel: 1, isTradeAccount: true });
    const c = await customer({ email: "c@example.com" });
    const noEmail = await customer({ email: null });
    await sale(a.id, "ORDER", "2026-10-05", { storeLocationId: store.id });
    await sale(b.id, "FULFILLED", "2026-10-20", { storeLocation: "harbor" }); // imported: name only
    await sale(c.id, "QUOTE", "2026-10-10", { storeLocationId: store.id }); // a quote isn't a sale
    await sale(c.id, "CANCELLED", "2026-10-11", { storeLocationId: store.id });
    await sale(noEmail.id, "ORDER", "2026-10-05", { storeLocationId: store.id });
    return { store, s };
  }

  async function list(query: Record<string, string>) {
    const res = makeRes();
    await emailListRoute(request("GET", query), res, {
      user: { email: "owner@example.com" },
    } as Session);
    return res;
  }

  const emails = (res: TestRes) =>
    (res.body.sample as { email: string }[]).map((r) => r.email).sort();

  it("everyone with an email, and only them", async () => {
    await world();
    const res = await list({});
    expect([res.body.count, emails(res)]).toEqual([
      3,
      ["a@example.com", "b@example.com", "c@example.com"],
    ]);
  });

  it("filters by when they bought, where, level, trade and source", async () => {
    const { store, s } = await world();
    expect(emails(await list({ boughtFrom: "2026-10-01", boughtTo: "2026-10-31" }))).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(emails(await list({ boughtFrom: "2026-10-06" }))).toEqual(["b@example.com"]);
    expect(emails(await list({ storeLocationId: String(store.id) }))).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(emails(await list({ minLevel: "2" }))).toEqual(["a@example.com"]);
    expect(emails(await list({ trade: "trade" }))).toEqual(["b@example.com"]);
    expect(emails(await list({ trade: "retail" }))).toEqual(["a@example.com", "c@example.com"]);
    expect(emails(await list({ referralSourceId: String(s.id) }))).toEqual(["a@example.com"]);
  });

  it("downloads as a CSV, and refuses a filter it can't read", async () => {
    await world();
    const csv = await list({ format: "csv", minLevel: "2" });
    expect(String(csv.body).split("\n")[0]).toBe(
      "Email,First name,Last name,Level,Trade,Heard of us,Last order",
    );
    expect(String(csv.body)).toContain("a@example.com");
    const bads: Record<string, string>[] = [
      { boughtFrom: "Oct 1" },
      { boughtFrom: "2026-10-31", boughtTo: "2026-10-01" },
      { trade: "both" },
      { minLevel: "-1" },
    ];
    for (const bad of bads) {
      expect((await list(bad)).statusCode).toBe(400);
    }
  });
});

describe("Reports › Referrals", () => {
  it("counts customers, buyers and spend by source and by who sent them, as revenue counts it", async () => {
    const friend = await source("A friend");
    const insta = await source("Instagram");
    const sender = await customer({ firstName: "Grace", lastName: "Hopper" });
    const x = await customer({ referralSourceId: friend.id, referredByCustomerId: sender.id });
    const y = await customer({ referralSourceId: friend.id, referredByCustomerId: sender.id });
    await customer({ referralSourceId: insta.id });
    const order = (customerId: number, status: string, lines: [number, string][]) =>
      prisma.salesOrder.create({
        data: {
          orderno: `SO-${Math.random()}`,
          customerId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: status as any,
          lineItems: {
            create: lines.map(([netPrice, lineItemStatus]) => ({
              orderedQuantity: 1,
              netPrice,
              cost: 0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              lineItemStatus: lineItemStatus as any,
            })),
          },
        },
      });
    await order(x.id, "ORDER", [
      [1000, "ACTIVE"],
      [400, "CANCELLED"],
    ]); // cancelled line out
    await order(x.id, "RETURNED", [[-200, "ACTIVE"]]); // a return nets out
    await order(y.id, "QUOTE", [[999, "ACTIVE"]]); // a quote isn't spend

    const report = await getReferralReport(prisma);
    expect(report.bySource.map((r) => [r.name, r.customers, r.buyers, r.revenue])).toEqual([
      ["A friend", 2, 1, 800],
      ["Instagram", 1, 0, 0],
      ["Not recorded", 1, 0, 0],
    ]);
    expect(report.referrers).toEqual([
      { referrerId: sender.id, name: "Grace Hopper", customers: 2, buyers: 1, revenue: 800 },
    ]);
  });
});

describe("The customer list (CodeQL #24)", () => {
  // It wrote whatever column it was sent into orderBy, and returned as many
  // rows as it was asked for.
  it("sorts only by its own columns, either way", async () => {
    await customer({ firstName: "Bo", lastName: "Zed" });
    await customer({ firstName: "Al", lastName: "Ash" });
    const asc = await call(customersRoute, "GET", { sortBy: "lastName" });
    expect(asc.body.data.map((c: { lastName: string }) => c.lastName)).toEqual(["Ash", "Zed"]);
    const desc = await call(customersRoute, "GET", { sortBy: "firstName", sortDirection: "desc" });
    expect(desc.body.data.map((c: { firstName: string }) => c.firstName)).toEqual(["Bo", "Al"]);
    // Anything but "desc" is ascending, never written into the query as sent.
    const odd = await call(customersRoute, "GET", { sortDirection: "sideways" });
    expect(odd.statusCode).toBe(200);
  });

  it("refuses any other column", async () => {
    for (const sortBy of ["creditBalance", "__proto__", "constructor"]) {
      const res = await call(customersRoute, "GET", { sortBy });
      expect([res.statusCode, res.body.error]).toEqual([400, expect.stringContaining(sortBy)]);
    }
  });

  it("returns at most 100 a page, and treats a page below 1 as the first", async () => {
    await prisma.customer.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({ firstName: "C", lastName: `L${i}` })),
    });
    const big = await call(customersRoute, "GET", { limit: "100000" });
    expect(big.body.data).toHaveLength(100);
    const below = await call(customersRoute, "GET", { page: "-3", limit: "5" });
    expect(below.statusCode).toBe(200);
    expect(below.body.data).toHaveLength(5);
  });
});
