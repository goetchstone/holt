// /app/__tests__/integration/clientBookRoutes.integration.test.ts
//
// GAP-36: the routes and pages behind My Clients, the pipeline's client panel and the
// customer page's Notes tab: who may use each, what they save, and that a note never
// counts as having reached someone.
//
// Real routes, real database; only the session readers are mocked.

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
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { getPipelineDetail } from "@/lib/reports/pipelineOpportunity";
import clientProfileRoute from "@/pages/api/customers/[id]/client-profile";
import interactionsRoute from "@/pages/api/sales/interactions";
import pipelineRoute from "@/pages/api/sales/pipeline";
import pipelineArchiveRoute from "@/pages/api/sales/pipeline/[id]";
import clientsRoute from "@/pages/api/sales/clients";
import assignRoute from "@/pages/api/sales/clients/assign";
import mergeRoute from "@/pages/api/customers/merge-duplicates";
import settingsRoute from "@/pages/api/admin/settings";
import ClientsPage from "@/app/(dashboard)/app/sales/clients/page";
import CustomerPage from "@/app/(dashboard)/app/sales/customers/[id]/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  route: Route,
  who: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: Record<string, string>; body?: object } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: who, email: `${who}@example.com` },
  });
  let status = 200;
  let payload: unknown;
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
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload as Body };
}

async function makeStaff(who: string, roleKey: string, displayName = who) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName,
      role: roleKey as never,
      roleId: role.id,
      defaultStore: "Main Street",
    },
  });
}

function makeClient(firstName: string, lastName: string, primaryDesignerId?: number) {
  return prisma.customer.create({ data: { firstName, lastName, primaryDesignerId } });
}

let quoteNumber = 0;
function makeQuote(
  customerId: number | null,
  salesPersonId: number | null,
  over: { salesperson?: string; storeLocation?: string; status?: "QUOTE" | "ORDER" } = {},
) {
  quoteNumber += 1;
  return prisma.salesOrder.create({
    data: {
      orderno: `Q-${quoteNumber}`,
      status: over.status ?? "QUOTE",
      customerId,
      salesPersonId,
      salesperson: over.salesperson,
      storeLocation: over.storeLocation,
      orderDate: new Date(),
      quoteDate: new Date(),
    },
  });
}

function logInteraction(
  staffMemberId: number,
  customerId: number,
  source: string,
  startedAt: Date,
  over: { salesOrderId?: number; notes?: string } = {},
) {
  return prisma.customerInteraction.create({
    data: {
      staffMemberId,
      customerId,
      source,
      startedAt,
      storeLocation: "Main Street",
      isActive: false,
      ...over,
    },
  });
}

async function setStore(over: Record<string, unknown>) {
  await prisma.appSettings.update({ where: { organizationId: DEFAULT_ORG_ID }, data: over });
  invalidateAppSettingsCache();
}

const DAY = 86_400_000;

// 01:00 on the 15th in Auckland; still the 14th in UTC and on the US east coast.
const useStoreClock = () =>
  jest.useFakeTimers({
    now: new Date("2026-06-14T13:00:00.000Z"),
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });

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
  // Permissions are bypassed while no active admin exists (the bootstrap safeguard), so
  // without one every gate below would pass.
  await makeStaff("owner", "ADMIN", "Owner");
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a client's info and notes", () => {
  it("sends the store's lists, the store's day and every note and contact, newest first", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const client = await makeClient("Nora", "Vale");
    const other = await makeClient("Otto", "Other");
    const quote = await makeQuote(client.id, pat.id);
    await setStore({ clientProfileChoices: { budgets: ["Small", "Large"] } });
    const now = Date.now();
    await logInteraction(pat.id, client.id, "PHONE", new Date(now - 2 * DAY), {
      salesOrderId: quote.id,
      notes: "Left a message",
    });
    await logInteraction(pat.id, client.id, "NOTE", new Date(now - DAY), {
      notes: "Summer home",
    });
    await logInteraction(pat.id, other.id, "NOTE", new Date(now), { notes: "Someone else" });

    const { status, body } = await call(clientProfileRoute, "pat", {
      query: { id: String(client.id) },
    });

    expect(status).toBe(200);
    expect(body.choices.budgets).toEqual(["Small", "Large"]);
    expect(body.today).toBe(new Date().toISOString().slice(0, 10));
    expect(body.profile.projectDescription).toBeNull();
    expect(body.history.map((h: Body) => h.notes)).toEqual(["Summer home", "Left a message"]);
    expect(body.history[1]).toMatchObject({
      source: "PHONE",
      staffMember: { displayName: "Pat Lund" },
      salesOrder: { id: quote.id, orderno: quote.orderno },
    });
  });

  it.each(["WAREHOUSE", "DISPATCH", "INSTALLER", "MARKETING"])(
    "%s can read a customer but not what salespeople keep on them",
    async (role) => {
      await makeStaff("viewer", role);
      const client = await makeClient("Nora", "Vale");
      const { status } = await call(clientProfileRoute, "viewer", {
        query: { id: String(client.id) },
      });
      expect(status).toBe(403);
    },
  );

  it.each(["CUSTOMER_SERVICE", "REGISTER", "DESIGNER", "MANAGER"])(
    "%s deals with clients, so can read it",
    async (role) => {
      await makeStaff("viewer", role);
      const client = await makeClient("Nora", "Vale");
      const { status } = await call(clientProfileRoute, "viewer", {
        query: { id: String(client.id) },
      });
      expect(status).toBe(200);
    },
  );

  it("only someone who works the pipeline can save it, and it records who", async () => {
    await makeStaff("service", "CUSTOMER_SERVICE");
    await makeStaff("pat", "DESIGNER");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Nora", "Vale");
    const query = { id: String(client.id) };
    const body = { projectDescription: "Lake house", budgetRange: "Open" };

    expect((await call(clientProfileRoute, "service", { method: "PUT", query, body })).status).toBe(
      403,
    );
    expect(await prisma.clientProfile.count()).toBe(0);

    const saved = await call(clientProfileRoute, "pat", { method: "PUT", query, body });
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toMatchObject({
      projectDescription: "Lake house",
      budgetRange: "Open",
    });

    await call(clientProfileRoute, "mo", { method: "PUT", query, body });
    const row = await prisma.clientProfile.findUniqueOrThrow({ where: { customerId: client.id } });
    expect(row).toMatchObject({ createdBy: "pat@example.com", updatedBy: "mo@example.com" });
    expect(row.searchText).toContain("Lake house");
    expect(await prisma.clientProfile.count()).toBe(1);
  });

  it("says what's wrong: a bad id, no such client, the Cash Sale customer", async () => {
    await makeStaff("pat", "DESIGNER");
    const cash = await makeClient("Cash", "Sale");
    const put = (id: string) =>
      call(clientProfileRoute, "pat", { method: "PUT", query: { id }, body: {} });

    expect((await put("abc")).status).toBe(400);
    expect((await call(clientProfileRoute, "pat", { query: { id: "abc" } })).status).toBe(400);
    const missing = await put("99999");
    expect(missing).toMatchObject({ status: 404, body: { error: "Client not found" } });
    const cashSale = await put(String(cash.id));
    expect(cashSale.status).toBe(400);
    expect(cashSale.body.error).toMatch(/Cash Sale/);
    expect(await prisma.clientProfile.count()).toBe(0);
  });

  it("checks answers against the store's lists, and keeps an answer since removed", async () => {
    await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const query = { id: String(client.id) };
    await call(clientProfileRoute, "pat", {
      method: "PUT",
      query,
      body: { budgetRange: "Open" },
    });

    await setStore({ clientProfileChoices: { budgets: ["Small"] } });

    const refused = await call(clientProfileRoute, "pat", {
      method: "PUT",
      query,
      body: { budgetRange: "25K+" },
    });
    expect(refused.status).toBe(400);
    const kept = await call(clientProfileRoute, "pat", {
      method: "PUT",
      query,
      body: { budgetRange: "Open", projectDescription: "Still open" },
    });
    expect(kept.status).toBe(200);
    expect(kept.body.profile).toMatchObject({
      budgetRange: "Open",
      projectDescription: "Still open",
    });
  });

  it("gives today by the store's clock", async () => {
    await setStore({ timezone: "Pacific/Auckland" });
    useStoreClock();
    await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const { body } = await call(clientProfileRoute, "pat", { query: { id: String(client.id) } });
    expect(body.today).toBe("2026-06-15");
  });

  it("the database refuses a close likelihood out of range, whatever a route lets through", async () => {
    const client = await makeClient("Nora", "Vale");
    await expect(
      prisma.clientProfile.create({ data: { customerId: client.id, closeLikelihood: 11 } }),
    ).rejects.toThrow();
    await expect(
      prisma.clientProfile.create({ data: { customerId: client.id, closeLikelihood: 0 } }),
    ).rejects.toThrow();
  });

  it("takes only GET and PUT", async () => {
    await makeStaff("pat", "DESIGNER");
    const { status } = await call(clientProfileRoute, "pat", {
      method: "POST",
      query: { id: "1" },
    });
    expect(status).toBe(405);
  });
});

describe("logging a note or a contact", () => {
  const post = (who: string, body: object) =>
    call(interactionsRoute, who, { method: "POST", body });

  it("logs a note on a client with no quote", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");

    const { status, body } = await post("pat", {
      customerId: client.id,
      source: "NOTE",
      notes: "Summer home",
    });

    expect(status).toBe(201);
    const row = await prisma.customerInteraction.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({
      customerId: client.id,
      salesOrderId: null,
      staffMemberId: pat.id,
      source: "NOTE",
      notes: "Summer home",
      storeLocation: "Main Street",
      isActive: false,
      createdBy: "pat@example.com",
    });
  });

  it("finds the client from the quote and uses the quote's store", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, pat.id, { storeLocation: "Harbor Road" });

    const { body } = await post("pat", {
      salesOrderId: quote.id,
      source: "PHONE",
      notes: "Called",
      nextFollowUpDate: "2031-03-04",
    });

    const row = await prisma.customerInteraction.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ customerId: client.id, storeLocation: "Harbor Road" });
    const profile = await prisma.clientProfile.findUniqueOrThrow({
      where: { customerId: client.id },
    });
    expect(profile.nextFollowUpDate?.toISOString().slice(0, 10)).toBe("2031-03-04");
    expect(profile).toMatchObject({ createdBy: "pat@example.com", updatedBy: "pat@example.com" });
  });

  it("leaves the follow-up date alone unless told, and null clears it", async () => {
    await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const date = async () =>
      (
        await prisma.clientProfile.findUniqueOrThrow({ where: { customerId: client.id } })
      ).nextFollowUpDate
        ?.toISOString()
        .slice(0, 10) ?? null;
    const base = { customerId: client.id, source: "PHONE", notes: "Called" };

    await post("pat", { ...base, nextFollowUpDate: "2031-03-04" });
    await post("pat", base);
    expect(await date()).toBe("2031-03-04");
    await post("pat", { ...base, nextFollowUpDate: "2031-05-06" });
    expect(await date()).toBe("2031-05-06");
    await post("pat", { ...base, nextFollowUpDate: null });
    expect(await date()).toBeNull();
    expect(await prisma.clientProfile.count()).toBe(1);
  });

  it("writes nothing it refuses", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const cash = await makeClient("Cash", "Sale");
    const noClient = await makeQuote(null, pat.id);
    const followUp = { source: "PHONE", notes: "Called", nextFollowUpDate: "2031-03-04" };

    const bad = await post("pat", { source: "FAX", customerId: cash.id, notes: "x" });
    expect(bad.status).toBe(400);
    expect(await post("pat", { ...followUp, salesOrderId: 99999 })).toMatchObject({
      status: 404,
      body: { error: "Quote not found" },
    });
    expect(await post("pat", { ...followUp, customerId: 99999 })).toMatchObject({
      status: 404,
      body: { error: "Client not found" },
    });
    expect(await post("pat", { ...followUp, salesOrderId: noClient.id })).toMatchObject({
      status: 400,
      body: { error: "A follow-up date needs a client." },
    });
    expect(await post("pat", { ...followUp, customerId: cash.id })).toMatchObject({
      status: 400,
      body: { error: "The Cash Sale customer can't have a follow-up date." },
    });
    expect(await prisma.customerInteraction.count()).toBe(0);
    expect(await prisma.clientProfile.count()).toBe(0);
  });

  it("is for people who work the pipeline", async () => {
    await makeStaff("service", "CUSTOMER_SERVICE");
    const client = await makeClient("Nora", "Vale");
    const { status } = await post("service", {
      customerId: client.id,
      source: "NOTE",
      notes: "x",
    });
    expect(status).toBe(403);
    expect(await prisma.customerInteraction.count()).toBe(0);
  });
});

describe("the pipeline", () => {
  const mine = async (who: string, query: Record<string, string> = {}) =>
    (await call(pipelineRoute, who, { query })).body;

  it("shows a note on the card but doesn't count it as contact", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, pat.id);
    const phoned = new Date(Date.now() - 3 * DAY);
    await logInteraction(pat.id, client.id, "PHONE", phoned, { salesOrderId: quote.id });
    await logInteraction(pat.id, client.id, "NOTE", new Date(Date.now() - DAY), {
      salesOrderId: quote.id,
      notes: "Summer home",
    });
    await logInteraction(pat.id, client.id, "MANAGER_NOTE", new Date(), {
      salesOrderId: quote.id,
      notes: "Push this one",
    });

    const [card] = (await mine("pat")).quotes;

    expect(card.lastInteractionAt).toBe(phoned.toISOString());
    expect(card.daysSinceContact).toBe(3);
    expect(card.interactions.map((i: Body) => i.source)).toEqual(["MANAGER_NOTE", "NOTE", "PHONE"]);
  });

  it("reads as never contacted when all there is are notes", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, pat.id);
    await logInteraction(pat.id, client.id, "NOTE", new Date(), { salesOrderId: quote.id });
    const [card] = (await mine("pat")).quotes;
    expect(card.lastInteractionAt).toBeNull();
    expect(card.daysSinceContact).toBeNull();
  });

  it("puts a client note on all their quotes, and a manager's note only on its own", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const first = await makeQuote(client.id, pat.id);
    const second = await makeQuote(client.id, pat.id);
    await logInteraction(pat.id, client.id, "NOTE", new Date(), {
      salesOrderId: first.id,
      notes: "Client note",
    });
    await logInteraction(pat.id, client.id, "MANAGER_NOTE", new Date(), {
      salesOrderId: first.id,
      notes: "Manager note",
    });

    const { quotes } = await mine("pat");
    const notesOn = (id: number) =>
      quotes
        .find((q: Body) => q.id === id)
        .interactions.map((i: Body) => i.notes)
        .sort();

    expect(notesOn(first.id)).toEqual(["Client note", "Manager note"]);
    expect(notesOn(second.id)).toEqual(["Client note"]);
  });

  describe("in the store's own time", () => {
    beforeEach(async () => {
      await setStore({ timezone: "Pacific/Auckland" });
    });

    it("counts days since contact and today by the store's clock", async () => {
      useStoreClock();
      const pat = await makeStaff("pat", "DESIGNER");
      const client = await makeClient("Nora", "Vale");
      const quote = await makeQuote(client.id, pat.id);
      // Three hours ago: 22:00 yesterday in Auckland, the same day in UTC and Eastern.
      await logInteraction(pat.id, client.id, "PHONE", new Date("2026-06-14T10:00:00.000Z"), {
        salesOrderId: quote.id,
      });

      const body = await mine("pat");

      expect(body.today).toBe("2026-06-15");
      expect(body.quotes[0].daysSinceContact).toBe(1);
    });

    it("holds a follow-up due from the store's day", async () => {
      useStoreClock();
      const pat = await makeStaff("pat", "DESIGNER");
      const client = await makeClient("Nora", "Vale");
      await makeQuote(client.id, pat.id);
      await prisma.clientProfile.create({
        data: { customerId: client.id, nextFollowUpDate: new Date("2026-06-15T00:00:00.000Z") },
      });

      // It's the 15th there, so the 15th is due, though the server's clock says the 14th.
      expect((await mine("pat")).quotes[0].followUpState).toBe("due");

      await prisma.clientProfile.update({
        where: { customerId: client.id },
        data: { nextFollowUpDate: new Date("2026-06-16T00:00:00.000Z") },
      });
      expect((await mine("pat")).quotes[0].followUpState).toBe("scheduled");
    });
  });

  it("clears a due follow-up once someone has contacted them, not with a note", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, pat.id);
    await prisma.clientProfile.create({
      data: {
        customerId: client.id,
        nextFollowUpDate: new Date(new Date().toISOString().slice(0, 10)),
      },
    });
    await logInteraction(pat.id, client.id, "NOTE", new Date(), { salesOrderId: quote.id });
    expect((await mine("pat")).quotes[0].followUpState).toBe("due");

    await logInteraction(pat.id, client.id, "PHONE", new Date(), { salesOrderId: quote.id });
    expect((await mine("pat")).quotes[0].followUpState).toBe("current");
  });

  it("marks a quote with nothing priced on it as a placeholder", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const client = await makeClient("Nora", "Vale");
    const empty = await makeQuote(client.id, pat.id);
    const priced = await makeQuote(client.id, pat.id);
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: priced.id,
        productName: "Sofa",
        partNo: "S-1",
        orderedQuantity: 1,
        netPrice: 900,
        cost: 400,
      },
    });
    const { quotes } = await mine("pat");
    const card = (id: number) => quotes.find((q: Body) => q.id === id);
    expect(card(empty.id).isPlaceholderQuote).toBe(true);
    expect(card(priced.id).isPlaceholderQuote).toBe(false);
    expect(card(priced.id).lineItemSummary).toContain("Sofa");
  });

  describe("search", () => {
    it("finds a client by what's noted, and a salesperson only among their own", async () => {
      const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
      const sam = await makeStaff("sam", "DESIGNER", "Sam Reed");
      await makeStaff("mo", "MANAGER");
      const hers = await makeClient("Nora", "Vale");
      const his = await makeClient("Otto", "Rand");
      const herQuote = await makeQuote(hers.id, pat.id);
      const hisQuote = await makeQuote(his.id, sam.id);
      await logInteraction(pat.id, hers.id, "NOTE", new Date(), { notes: "Summer home" });
      await logInteraction(sam.id, his.id, "NOTE", new Date(), { notes: "Summer place" });

      const ids = (body: Body) => body.quotes.map((q: Body) => q.id).sort();

      const asPat = await mine("pat", { search: "summer" });
      expect(asPat.scope).toBe("search");
      expect(ids(asPat)).toEqual([herQuote.id]);
      expect(ids(await mine("mo", { search: "summer" }))).toEqual(
        [herQuote.id, hisQuote.id].sort((a, b) => a - b),
      );
      expect(ids(await mine("pat", { search: "vale" }))).toEqual([herQuote.id]);
      expect(ids(await mine("pat", { search: "nothing-like-this" }))).toEqual([]);
    });

    it("matches a client's info too", async () => {
      const pat = await makeStaff("pat", "DESIGNER");
      const client = await makeClient("Nora", "Vale");
      const quote = await makeQuote(client.id, pat.id);
      await call(clientProfileRoute, "pat", {
        method: "PUT",
        query: { id: String(client.id) },
        body: { projectDescription: "Lighthouse restoration" },
      });
      const { quotes } = await mine("pat", { search: "lighthouse" });
      expect(quotes.map((q: Body) => q.id)).toEqual([quote.id]);
    });
  });

  describe("All Staff", () => {
    it("counts quotes no one owns apart, leaving out the Cash Sale customer", async () => {
      const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
      await makeStaff("mo", "MANAGER");
      const owned = await makeClient("Nora", "Vale");
      const ownerless = await makeClient("Otto", "Rand");
      const cash = await makeClient("Cash", "Sale");
      await makeQuote(owned.id, pat.id);
      const orphan = await makeQuote(ownerless.id, null, { salesperson: "Long Gone" });
      await prisma.orderLineItem.create({
        data: {
          salesOrderId: orphan.id,
          productName: "Sofa",
          partNo: "S-1",
          orderedQuantity: 1,
          netPrice: 900,
          cost: 400,
        },
      });
      await makeQuote(cash.id, null, { salesperson: "Long Gone" });

      const body = await mine("mo", { scope: "all" });

      expect(body.staffSummaries.map((s: Body) => s.displayName)).toEqual(["Pat Lund"]);
      expect(body.unassigned).toEqual({ clientCount: 1, quoteCount: 1, totalValue: 900 });
    });

    it("counts someone overdue by when they were last reached, past any note", async () => {
      const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
      await makeStaff("mo", "MANAGER");
      const client = await makeClient("Nora", "Vale");
      const quote = await makeQuote(client.id, pat.id);
      const longAgo = new Date(Date.now() - 60 * DAY);
      await logInteraction(pat.id, client.id, "PHONE", longAgo, { salesOrderId: quote.id });
      await logInteraction(pat.id, client.id, "NOTE", new Date(), { salesOrderId: quote.id });

      const body = await mine("mo", { scope: "all" });

      expect(body.staffSummaries[0]).toMatchObject({ displayName: "Pat Lund", overdueCount: 1 });
    });

    it("isn't overdue once they've been reached", async () => {
      const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
      await makeStaff("mo", "MANAGER");
      const client = await makeClient("Nora", "Vale");
      const quote = await makeQuote(client.id, pat.id);
      await logInteraction(pat.id, client.id, "PHONE", new Date(), { salesOrderId: quote.id });
      const body = await mine("mo", { scope: "all" });
      expect(body.staffSummaries[0].overdueCount).toBe(0);
    });

    it("gives a salesperson their own pipeline instead", async () => {
      const pat = await makeStaff("pat", "DESIGNER");
      const client = await makeClient("Nora", "Vale");
      await makeQuote(client.id, pat.id);
      const body = await mine("pat", { scope: "all" });
      expect(body.scope).toBe("mine");
      expect(body.staffSummaries).toEqual([]);
      expect(body.unassigned).toBeUndefined();
    });
  });

  it("holds back the Cash Sale customer's contact details and client info", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    const cash = await prisma.customer.create({
      data: { firstName: "Cash", lastName: "Sale", phone: "202-555-0143", email: "a@example.com" },
    });
    await makeQuote(cash.id, pat.id);
    const [card] = (await mine("pat")).quotes;
    expect(card.customer).toMatchObject({ isCashSale: true, phone: null, email: null });
    expect(card.customer.history).toBeNull();
  });

  it("is for people who work the pipeline", async () => {
    await makeStaff("service", "CUSTOMER_SERVICE");
    expect((await call(pipelineRoute, "service")).status).toBe(403);
  });
});

// docs/tenant-literal-sweep.md: staff matched by substring. "Ann" could see and archive
// every quote written by "Anna Reyes", and All Staff credited them to whoever came first.
describe("who a salesperson's name means", () => {
  async function annAndAnna() {
    await makeStaff("ann", "DESIGNER", "Ann");
    await makeStaff("anna", "DESIGNER", "Anna Reyes");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, null, { salesperson: "Anna Reyes" });
    return { client, quote };
  }
  const archive = (who: string, id: number) =>
    call(pipelineArchiveRoute, who, {
      method: "PATCH",
      query: { id: String(id) },
      body: { archived: true },
    });
  const ids = (body: Body) => body.quotes.map((q: Body) => q.id);

  it("doesn't show one person's quote to someone whose name sits inside theirs", async () => {
    const { quote } = await annAndAnna();
    expect(ids((await call(pipelineRoute, "ann")).body)).toEqual([]);
    expect(ids((await call(pipelineRoute, "anna")).body)).toEqual([quote.id]);
  });

  it("won't let them archive it, but its salesperson can", async () => {
    const { quote } = await annAndAnna();
    expect((await archive("ann", quote.id)).status).toBe(403);
    const untouched = await prisma.salesOrder.findUniqueOrThrow({ where: { id: quote.id } });
    expect(untouched.pipelineArchivedAt).toBeNull();
    expect((await archive("anna", quote.id)).status).toBe(200);
  });

  it("won't let a stale name beat the linked id", async () => {
    await makeStaff("ann", "DESIGNER", "Ann");
    const anna = await makeStaff("anna", "DESIGNER", "Anna Reyes");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, anna.id, { salesperson: "Ann" });
    expect((await archive("ann", quote.id)).status).toBe(403);
    expect(ids((await call(pipelineRoute, "ann")).body)).toEqual([]);
    expect(ids((await call(pipelineRoute, "anna")).body)).toEqual([quote.id]);
  });

  it("credits All Staff to the right person, not whoever comes first", async () => {
    await annAndAnna();
    await makeStaff("mo", "MANAGER", "Mo Ames");
    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });
    expect(body.staffSummaries.map((s: Body) => [s.displayName, s.quoteCount])).toEqual([
      ["Anna Reyes", 1],
    ]);
  });

  it("lists it for their book and search, and not the other's", async () => {
    const { client } = await annAndAnna();
    const book = async (who: string) =>
      (await call(clientsRoute, who)).body.rows.map((r: Body) => r.id);
    expect(await book("ann")).toEqual([]);
    expect(await book("anna")).toEqual([client.id]);
    const found = await call(pipelineRoute, "ann", { query: { search: "vale" } });
    expect(ids(found.body)).toEqual([]);
  });

  it("follows an alias, which is how a POS's own spelling is handled", async () => {
    const anna = await makeStaff("anna", "DESIGNER", "Anna Reyes");
    await prisma.staffMember.update({
      where: { id: anna.id },
      data: { aliases: ["Reyes, Anna"] },
    });
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, null, { salesperson: "Reyes, Anna" });

    expect(ids((await call(pipelineRoute, "anna")).body)).toEqual([quote.id]);
    expect((await call(clientsRoute, "anna")).body.rows.map((r: Body) => r.id)).toEqual([
      client.id,
    ]);
    const found = await call(pipelineRoute, "anna", { query: { search: "vale" } });
    expect(ids(found.body)).toEqual([quote.id]);
    expect((await archive("anna", quote.id)).status).toBe(200);
  });

  it("lands a name no one has under No Owner, where a manager can see it", async () => {
    await annAndAnna();
    await makeStaff("mo", "MANAGER", "Mo Ames");
    const client = await makeClient("Otto", "Rand");
    await makeQuote(client.id, null, { salesperson: "Anna" });
    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });
    expect(body.unassigned).toMatchObject({ clientCount: 1, quoteCount: 1 });
  });
});

describe("a client book", () => {
  it("shows a salesperson their own, whatever they ask for", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const sam = await makeStaff("sam", "DESIGNER", "Sam Reed");
    const hers = await makeClient("Nora", "Vale", pat.id);
    await makeClient("Otto", "Rand", sam.id);
    await makeClient("Una", "Owned");
    const ids = (body: Body) => body.rows.map((r: Body) => r.customerId ?? r.id);

    const own = await call(clientsRoute, "pat");
    expect(own.status).toBe(200);
    expect(own.body.staff).toEqual({ id: pat.id, displayName: "Pat Lund" });
    expect(ids(own.body)).toEqual([hers.id]);
    expect(own.body.staffOptions).toEqual([]);

    const asked = await call(clientsRoute, "pat", { query: { staffId: String(sam.id) } });
    expect(asked.body.staff.id).toBe(pat.id);
    expect(ids(asked.body)).toEqual([hers.id]);

    const ownerless = await call(clientsRoute, "pat", { query: { staffId: "unassigned" } });
    expect(ownerless.body.staff.id).toBe(pat.id);
    expect(ids(ownerless.body)).toEqual([hers.id]);
    expect(ownerless.body.assignOptions).toEqual([]);
  });

  it("lets a manager open anyone's, or the clients no one owns", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const mo = await makeStaff("mo", "MANAGER", "Mo Ames");
    await makeStaff("wes", "WAREHOUSE", "Wes Hall");
    const hers = await makeClient("Nora", "Vale", pat.id);
    const ownerless = await makeClient("Otto", "Rand");
    await makeQuote(ownerless.id, null, { salesperson: "Long Gone" });
    const ids = (body: Body) => body.rows.map((r: Body) => r.customerId ?? r.id);

    const opened = await call(clientsRoute, "mo", { query: { staffId: String(pat.id) } });
    expect(opened.body.staff).toEqual({ id: pat.id, displayName: "Pat Lund" });
    expect(ids(opened.body)).toEqual([hers.id]);
    expect(opened.body.staffOptions.map((s: Body) => s.displayName)).toEqual([
      "Mo Ames",
      "Owner",
      "Pat Lund",
      "Wes Hall",
    ]);
    expect(opened.body.assignOptions).toEqual([]);

    const list = await call(clientsRoute, "mo", { query: { staffId: "unassigned" } });
    expect(list.body.staff).toBeNull();
    expect(ids(list.body)).toEqual([ownerless.id]);
    expect(list.body.assignOptions).toEqual([
      { id: mo.id, displayName: "Mo Ames" },
      expect.objectContaining({ displayName: "Owner" }),
      { id: pat.id, displayName: "Pat Lund" },
    ]);

    const missing = await call(clientsRoute, "mo", { query: { staffId: "99999" } });
    expect(missing).toMatchObject({ status: 404, body: { error: "Staff member not found" } });
  });

  it("offers only people still here", async () => {
    await makeStaff("mo", "MANAGER", "Mo Ames");
    const gone = await makeStaff("gone", "DESIGNER", "Gone Designer");
    await prisma.staffMember.update({ where: { id: gone.id }, data: { isActive: false } });
    const ownerless = await makeClient("Otto", "Rand");
    await makeQuote(ownerless.id, null, { salesperson: "Long Gone" });

    const list = await call(clientsRoute, "mo", { query: { staffId: "unassigned" } });

    const names = (rows: Body[]) => rows.map((r) => r.displayName);
    expect(names(list.body.staffOptions)).not.toContain("Gone Designer");
    expect(names(list.body.assignOptions)).not.toContain("Gone Designer");
  });

  it("is for people who work the pipeline", async () => {
    await makeStaff("service", "CUSTOMER_SERVICE");
    expect((await call(clientsRoute, "service")).status).toBe(403);
    await makeStaff("pat", "DESIGNER");
    expect((await call(clientsRoute, "pat", { method: "POST" })).status).toBe(405);
  });
});

describe("assigning a client", () => {
  it("a manager gives one to a salesperson, and every order keeps who it's credited to", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Nora", "Vale");
    const order = await makeQuote(client.id, null, {
      salesperson: "Long Gone",
      status: "ORDER",
    });

    const { status, body } = await call(assignRoute, "mo", {
      method: "POST",
      body: { customerId: client.id, toStaffId: pat.id },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, clientCount: 1 });
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: client.id } });
    expect(saved.primaryDesignerId).toBe(pat.id);
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({ salesperson: "Long Gone", salesPersonId: null });
  });

  it("a salesperson can't, and a bad request says why", async () => {
    const pat = await makeStaff("pat", "DESIGNER");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Nora", "Vale");

    const asPat = await call(assignRoute, "pat", {
      method: "POST",
      body: { customerId: client.id, toStaffId: pat.id },
    });
    expect(asPat.status).toBe(403);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: client.id } })).primaryDesignerId,
    ).toBeNull();

    const bad = await call(assignRoute, "mo", { method: "POST", body: {} });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe("string");
    expect((await call(assignRoute, "mo", { method: "GET" })).status).toBe(405);
  });
});

describe("merging duplicate customers", () => {
  async function twins() {
    const pat = await prisma.staffMember.findUniqueOrThrow({
      where: { email: "owner@example.com" },
    });
    const master = await makeClient("Nora", "Vale");
    await prisma.customerExternalId.create({
      data: { customerId: master.id, externalId: "A-1" },
    });
    const duplicate = await makeClient("Nora", "Vale");
    return { pat, master, duplicate };
  }

  it("moves the duplicate's notes and client info to the record it keeps", async () => {
    const { pat, master, duplicate } = await twins();
    await logInteraction(pat.id, duplicate.id, "NOTE", new Date(), { notes: "Summer home" });
    await prisma.clientProfile.create({
      data: { customerId: duplicate.id, projectDescription: "Lake house" },
    });

    const { status } = await call(mergeRoute, "owner", { method: "POST" });

    expect(status).toBe(200);
    expect(await prisma.customer.findUnique({ where: { id: duplicate.id } })).toBeNull();
    const note = await prisma.customerInteraction.findFirstOrThrow();
    expect(note.customerId).toBe(master.id);
    const profile = await prisma.clientProfile.findFirstOrThrow();
    expect(profile).toMatchObject({ customerId: master.id, projectDescription: "Lake house" });
  });

  it("keeps what the record already says, and fills its gaps from the duplicate", async () => {
    const { master, duplicate } = await twins();
    await prisma.clientProfile.create({
      data: { customerId: master.id, projectDescription: "Kept" },
    });
    await prisma.clientProfile.create({
      data: {
        customerId: duplicate.id,
        projectDescription: "Dropped",
        stylePreferences: "Warm neutrals",
      },
    });

    await call(mergeRoute, "owner", { method: "POST" });

    const profiles = await prisma.clientProfile.findMany();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      customerId: master.id,
      projectDescription: "Kept",
      stylePreferences: "Warm neutrals",
    });
  });
});

describe("a store's lists in Settings", () => {
  it("saves them, shows them and refuses what isn't a list", async () => {
    const saved = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { clientProfileChoices: { rooms: [" Den ", "den", "Sunroom"] } },
    });
    expect(saved.status).toBe(200);

    const shown = await call(settingsRoute, "owner");
    expect(shown.body.settings.clientProfileChoices.rooms).toEqual(["Den", "Sunroom"]);
    expect(shown.body.settings.clientProfileChoices.budgets).toContain("Open");

    const refused = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { clientProfileChoices: { rooms: "Den" } },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/Rooms of interest/);
    const after = await call(settingsRoute, "owner");
    expect(after.body.settings.clientProfileChoices.rooms).toEqual(["Den", "Sunroom"]);
  });

  it("leaves them alone when saving something else", async () => {
    await setStore({ clientProfileChoices: { rooms: ["Den"] } });
    await call(settingsRoute, "owner", { method: "PUT", body: { orderNumberPrefix: "ABC" } });
    const after = await call(settingsRoute, "owner");
    expect(after.body.settings.clientProfileChoices.rooms).toEqual(["Den"]);
  });
});

describe("the pages", () => {
  function signIn(who: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: who });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  }

  it.each([
    ["DESIGNER", true, true],
    ["CUSTOMER_SERVICE", false, true],
    ["REGISTER", false, true],
    ["WAREHOUSE", false, false],
    ["DISPATCH", false, false],
  ])("the customer page tells %s: edit %s, notes %s", async (role, canWork, canSee) => {
    await makeStaff("viewer", role);
    signIn("viewer");
    const element = await CustomerPage({
      params: Promise.resolve({ id: "7" }),
      searchParams: Promise.resolve({}),
    });
    expect(element.props).toEqual({
      id: "7",
      canWorkClient: canWork,
      canSeeClientNotes: canSee,
      openOnNotes: false,
    });
  });

  it("opens on Notes when the link asks, only for someone who can see them", async () => {
    const opened = async (tab?: string) =>
      (
        await CustomerPage({
          params: Promise.resolve({ id: "7" }),
          searchParams: Promise.resolve({ tab }),
        })
      ).props.openOnNotes;
    await makeStaff("pat", "DESIGNER");
    signIn("pat");
    expect(await opened("notes")).toBe(true);
    expect(await opened("orders")).toBe(false);
    expect(await opened()).toBe(false);

    await makeStaff("wes", "WAREHOUSE");
    signIn("wes");
    expect(await opened("notes")).toBe(false);
  });

  it("My Clients is for people who work the pipeline", async () => {
    await makeStaff("pat", "DESIGNER");
    signIn("pat");
    const own = await ClientsPage({ searchParams: Promise.resolve({}) });
    expect(own.props.linkedBook).toBeNull();
    const ownerless = await ClientsPage({
      searchParams: Promise.resolve({ staff: "unassigned" }),
    });
    expect(ownerless.props.linkedBook).toBe("unassigned");
    const other = await ClientsPage({ searchParams: Promise.resolve({ staff: "12" }) });
    expect(other.props.linkedBook).toBeNull();

    await makeStaff("wes", "WAREHOUSE");
    signIn("wes");
    await expect(ClientsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/REDIRECT/);
  });
});

describe("the Pipeline Opportunity report", () => {
  it("reads last contact past any number of notes, and still shows the newest note", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, pat.id, { salesperson: "Pat Lund" });
    const at = (days: number) => new Date(Date.now() - days * DAY);
    await logInteraction(pat.id, client.id, "PHONE", at(9), { salesOrderId: quote.id });
    for (const days of [4, 3, 2, 1]) {
      await logInteraction(pat.id, client.id, "NOTE", at(days), {
        salesOrderId: quote.id,
        notes: `Note ${days}`,
      });
    }

    const { rows } = await getPipelineDetail(prisma, { salesperson: "Pat Lund" } as never);

    expect(rows[0].lastInteraction).toBe(at(9).toISOString().slice(0, 10));
    expect(rows[0].lastNote).toBe("Note 1");
  });

  it("has no last contact when there are only notes", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeQuote(client.id, pat.id, { salesperson: "Pat Lund" });
    await logInteraction(pat.id, client.id, "MANAGER_NOTE", new Date(), {
      salesOrderId: quote.id,
      notes: "Push this one",
    });
    const { rows } = await getPipelineDetail(prisma, { salesperson: "Pat Lund" } as never);
    expect(rows[0].lastInteraction).toBeNull();
    expect(rows[0].lastNote).toBe("Push this one");
  });
});
