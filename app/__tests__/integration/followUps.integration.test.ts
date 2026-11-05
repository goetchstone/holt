// /app/__tests__/integration/followUps.integration.test.ts
//
// GAP-36: logging a contact with no quote, who gets suggested, the Follow-Ups report and the
// morning email. Real routes and queries, real database; only the session readers are mocked.

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
jest.mock("@/lib/email/queue", () => {
  const actual = jest.requireActual("@/lib/email/queue");
  return { ...actual, enqueueEmail: jest.fn(actual.enqueueEmail) };
});
jest.mock("@/lib/followUpReportQuery", () => {
  const actual = jest.requireActual("@/lib/followUpReportQuery");
  return { ...actual, loadFollowUpRows: jest.fn(actual.loadFollowUpRows) };
});

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { enqueueEmail } from "@/lib/email/queue";
import { queueFollowUpEmails } from "@/lib/followUpEmail";
import {
  countQuotesWaitingByStaff,
  loadFollowUpRows,
  loadRecentContacts,
} from "@/lib/followUpReportQuery";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";
import clientsRoute from "@/pages/api/sales/clients";
import pipelineRoute from "@/pages/api/sales/pipeline";
import interactionsRoute from "@/pages/api/sales/interactions";
import settingsRoute from "@/pages/api/admin/settings";
import emailQueueRoute from "@/pages/api/automations/email-queue";
import ClientsPage from "@/app/(dashboard)/app/sales/clients/page";
import FollowUpsPage from "@/app/(dashboard)/app/reports/follow-ups/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  route: Route,
  who: string,
  {
    method = "GET",
    query = {},
    body = {},
    authorization,
  }: {
    method?: string;
    query?: Record<string, string>;
    body?: object;
    authorization?: string;
  } = {},
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
    {
      method,
      query,
      body,
      cookies: {},
      headers: authorization ? { authorization } : {},
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload as Body };
}

function caller(who: string) {
  const ctx: TrpcContext = {
    userId: who,
    userEmail: `${who}@example.com`,
    tokenRole: null,
    impersonate: null,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx);
}

async function makeStaff(who: string, roleKey = "DESIGNER", displayName = who) {
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

function makeClient(
  firstName: string,
  lastName: string,
  over: { primaryDesignerId?: number; lifetimeSpend?: number; email?: string; phone?: string } = {},
) {
  return prisma.customer.create({ data: { firstName, lastName, ...over } });
}

let orderNumber = 0;
function makeOrder(
  customerId: number,
  over: {
    status?: "QUOTE" | "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED";
    salesPersonId?: number | null;
    salesperson?: string;
    storeLocation?: string;
    orderDate?: Date;
    archived?: boolean;
  } = {},
) {
  orderNumber += 1;
  return prisma.salesOrder.create({
    data: {
      orderno: `F-${orderNumber}`,
      status: over.status ?? "QUOTE",
      customerId,
      salesPersonId: over.salesPersonId ?? null,
      salesperson: over.salesperson,
      storeLocation: over.storeLocation,
      orderDate: over.orderDate ?? new Date(),
      quoteDate: over.orderDate ?? new Date(),
      pipelineArchivedAt: over.archived ? new Date() : null,
    },
  });
}

function addLine(
  salesOrderId: number,
  netPrice: number,
  over: { status?: "ACTIVE" | "CANCELLED" | "REPLACED" | "BACKORDERED"; qty?: number } = {},
) {
  return prisma.orderLineItem.create({
    data: {
      salesOrderId,
      productName: "Sofa",
      partNo: `S-${salesOrderId}-${netPrice}`,
      orderedQuantity: over.qty ?? 1,
      netPrice,
      cost: 1,
      lineItemStatus: over.status ?? "ACTIVE",
    },
  });
}

function logEntry(
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

function setFollowUp(customerId: number, day: string, updatedBy?: string) {
  return prisma.clientProfile.upsert({
    where: { customerId },
    create: { customerId, nextFollowUpDate: new Date(`${day}T00:00:00.000Z`), updatedBy },
    update: { nextFollowUpDate: new Date(`${day}T00:00:00.000Z`), updatedBy },
  });
}

async function setStore(over: Record<string, unknown>) {
  await prisma.appSettings.update({ where: { organizationId: DEFAULT_ORG_ID }, data: over });
  invalidateAppSettingsCache();
}

const NOON = new Date("2026-11-05T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const todayKey = () => new Date().toISOString().slice(0, 10);
const dayFromToday = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

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
  // Permissions are bypassed while no active admin exists, so one always does here. Its
  // follow-ups are empty, so it never gets an email.
  await makeStaff("owner", "ADMIN", "Owner");
  (enqueueEmail as jest.Mock).mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a contact logged with no quote", () => {
  it("shows on all the client's quotes and counts as reaching them", async () => {
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale");
    const first = await makeOrder(client.id, { salesPersonId: pat.id });
    const second = await makeOrder(client.id, { salesPersonId: pat.id });

    const logged = await call(interactionsRoute, "pat", {
      method: "POST",
      body: { customerId: client.id, source: "PHONE", notes: "Called about the spring" },
    });
    expect(logged.status).toBe(201);

    const { quotes } = (await call(pipelineRoute, "pat")).body;
    for (const id of [first.id, second.id]) {
      const card = quotes.find((q: Body) => q.id === id);
      expect(card.interactions.map((i: Body) => i.notes)).toEqual(["Called about the spring"]);
      expect(card.daysSinceContact).toBe(0);
    }
  });

  it("while a contact about one quote stays on that quote", async () => {
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale");
    const first = await makeOrder(client.id, { salesPersonId: pat.id });
    const second = await makeOrder(client.id, { salesPersonId: pat.id });
    await logEntry(pat.id, client.id, "PHONE", new Date(), {
      salesOrderId: first.id,
      notes: "One",
    });

    const { quotes } = (await call(pipelineRoute, "pat")).body;
    const card = (id: number) => quotes.find((q: Body) => q.id === id);
    expect(card(first.id).daysSinceContact).toBe(0);
    expect(card(second.id).interactions).toEqual([]);
    expect(card(second.id).lastInteractionAt).toBeNull();
  });
});

describe("All Staff", () => {
  it("tells a date that has arrived from a quote left too long", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("mo", "MANAGER");
    const dated = await makeClient("Nora", "Vale");
    const left = await makeClient("Otto", "Rand");
    await makeOrder(dated.id, { salesPersonId: pat.id });
    await setFollowUp(dated.id, todayKey());
    await makeOrder(left.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });

    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });

    expect(body.staffSummaries[0]).toMatchObject({ dueCount: 1, overdueCount: 1, quoteCount: 2 });
  });

  it("counts a contact with no quote as reaching them", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Otto", "Rand");
    await makeOrder(client.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await logEntry(pat.id, client.id, "PHONE", new Date());
    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });
    expect(body.staffSummaries[0]).toMatchObject({ dueCount: 0, overdueCount: 0 });
  });

  it("but not a note", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Otto", "Rand");
    await makeOrder(client.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await logEntry(pat.id, client.id, "NOTE", new Date());
    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });
    expect(body.staffSummaries[0]).toMatchObject({ overdueCount: 1 });
  });

  it("goes by whichever contact was later, on the quote or about the client", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("mo", "MANAGER");
    const calledSince = await makeClient("Otto", "Rand");
    const firstQuote = await makeOrder(calledSince.id, {
      salesPersonId: pat.id,
      orderDate: daysAgo(30),
    });
    await logEntry(pat.id, calledSince.id, "PHONE", daysAgo(20), { salesOrderId: firstQuote.id });
    await logEntry(pat.id, calledSince.id, "PHONE", new Date());
    const calledOnQuote = await makeClient("Una", "Pike");
    const secondQuote = await makeOrder(calledOnQuote.id, {
      salesPersonId: pat.id,
      orderDate: daysAgo(30),
    });
    await logEntry(pat.id, calledOnQuote.id, "PHONE", daysAgo(20));
    await logEntry(pat.id, calledOnQuote.id, "PHONE", new Date(), { salesOrderId: secondQuote.id });

    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });

    expect(body.staffSummaries[0]).toMatchObject({ quoteCount: 2, overdueCount: 0 });
  });

  it("doesn't count a contact on one quote for the client's other quote", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Otto", "Rand");
    const called = await makeOrder(client.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await makeOrder(client.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await logEntry(pat.id, client.id, "PHONE", new Date(), { salesOrderId: called.id });

    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });

    expect(body.staffSummaries[0]).toMatchObject({ quoteCount: 2, overdueCount: 1 });
  });
});

describe("what a quote is worth (rules 31 and 33)", () => {
  it("leaves cancelled, replaced and zero-quantity lines out of the pipeline's totals", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeOrder(client.id, { salesPersonId: pat.id });
    await addLine(quote.id, 100);
    await addLine(quote.id, 40, { status: "BACKORDERED" });
    await addLine(quote.id, 7000, { status: "CANCELLED" });
    await addLine(quote.id, 8000, { status: "REPLACED" });
    await addLine(quote.id, 9000, { qty: 0 });

    const card = (await call(pipelineRoute, "pat")).body.quotes[0];
    expect(card.totalAmount).toBe(140);
    const grid = (await call(pipelineRoute, "mo", { query: { scope: "all" } })).body;
    expect(grid.staffSummaries[0].totalValue).toBe(140);
  });

  it("reads a quote with only cancelled lines as a placeholder", async () => {
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeOrder(client.id, { salesPersonId: pat.id });
    await addLine(quote.id, 7000, { status: "CANCELLED" });
    const card = (await call(pipelineRoute, "pat")).body.quotes[0];
    expect(card.isPlaceholderQuote).toBe(true);
    expect(card.totalAmount).toBe(0);
  });

  it("and one whose only line has no price", async () => {
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeOrder(client.id, { salesPersonId: pat.id });
    await addLine(quote.id, 0);
    const card = (await call(pipelineRoute, "pat")).body.quotes[0];
    expect(card.isPlaceholderQuote).toBe(true);
  });

  it("and in the no-owner card's value", async () => {
    await makeStaff("mo", "MANAGER");
    const client = await makeClient("Otto", "Rand");
    const quote = await makeOrder(client.id, { salesperson: "Long Gone" });
    await addLine(quote.id, 100);
    await addLine(quote.id, 7000, { status: "CANCELLED" });
    const { body } = await call(pipelineRoute, "mo", { query: { scope: "all" } });
    expect(body.unassigned.totalValue).toBe(100);
  });
});

describe("the follow-up views on My Clients", () => {
  it("lists who's due and who's scheduled, with what the card needs", async () => {
    const pat = await makeStaff("pat");
    const due = await makeClient("Nora", "Vale", { primaryDesignerId: pat.id });
    const coming = await makeClient("Otto", "Rand", { primaryDesignerId: pat.id });
    await makeClient("Una", "Pike", { primaryDesignerId: pat.id });
    await setFollowUp(due.id, todayKey());
    await setFollowUp(coming.id, dayFromToday(3));
    const contacted = daysAgo(2);
    await logEntry(pat.id, due.id, "PHONE", contacted);
    await logEntry(pat.id, coming.id, "NOTE", new Date());

    const view = async (followUp: string) =>
      (await call(clientsRoute, "pat", { query: { followUp } })).body;
    const dueRows = (await view("due")).rows;
    expect(dueRows.map((r: Body) => r.id)).toEqual([due.id]);
    expect(dueRows[0]).toMatchObject({ followUp: "due", lastContactAt: contacted.toISOString() });
    const comingRows = (await view("scheduled")).rows;
    expect(comingRows.map((r: Body) => r.id)).toEqual([coming.id]);
    // A note isn't a contact.
    expect(comingRows[0]).toMatchObject({ followUp: "scheduled", lastContactAt: null });
    expect((await view("all")).rows).toHaveLength(3);
    expect((await view("all")).today).toBe(todayKey());
  });
});

describe("who gets suggested", () => {
  const LONG_AGO = () => daysAgo(500);

  async function drifted(
    pat: { id: number },
    firstName = "Nora",
    spend = 6000,
    orderDate = LONG_AGO(),
  ) {
    const client = await makeClient(firstName, "Vale", {
      primaryDesignerId: pat.id,
      lifetimeSpend: spend,
    });
    await makeOrder(client.id, {
      status: "ORDER",
      salesPersonId: pat.id,
      orderDate,
    });
    return client;
  }
  const suggested = async (who: string) =>
    (await call(clientsRoute, who, { query: { followUp: "suggested" } })).body;
  const ids = (body: Body) => body.rows.map((r: Body) => r.id);

  it("suggests no one until the store sets a spend, and says so", async () => {
    const pat = await makeStaff("pat");
    await drifted(pat);
    const body = await suggested("pat");
    expect(body.outreach).toBeNull();
    expect(body.rows).toEqual([]);
  });

  it("lists a big client gone quiet, biggest first, once the store has", async () => {
    await setStore({ outreachMinLifetimeSpend: 5000 });
    const pat = await makeStaff("pat");
    // The default sort is most recent order first, which would put the smaller one first.
    const smaller = await drifted(pat, "Smaller", 6000, daysAgo(400));
    const bigger = await drifted(pat, "Bigger", 9000, daysAgo(600));
    const body = await suggested("pat");
    expect(ids(body)).toEqual([bigger.id, smaller.id]);
    expect(body.outreach).toEqual({ minLifetimeSpend: 5000, lapsedMonths: 12, quietDays: 90 });
  });

  it("goes by the store's numbers", async () => {
    await setStore({
      outreachMinLifetimeSpend: 5000,
      outreachLapsedMonths: 24,
      outreachQuietDays: 30,
    });
    const pat = await makeStaff("pat");
    const client = await drifted(pat);
    expect(ids(await suggested("pat"))).toEqual([]);
    await setStore({ outreachLapsedMonths: 6 });
    expect(ids(await suggested("pat"))).toEqual([client.id]);
    await logEntry(pat.id, client.id, "PHONE", daysAgo(10));
    expect(ids(await suggested("pat"))).toEqual([]);
  });

  it("leaves out anyone below the store's spend", async () => {
    await setStore({ outreachMinLifetimeSpend: 5000 });
    const pat = await makeStaff("pat");
    await drifted(pat, "Small", 4999);
    expect(ids(await suggested("pat"))).toEqual([]);
  });

  it("leaves out anyone with an open quote, a recent order or a date", async () => {
    await setStore({ outreachMinLifetimeSpend: 5000 });
    const pat = await makeStaff("pat");
    const quoted = await drifted(pat, "Quoted");
    await makeOrder(quoted.id, { salesPersonId: pat.id });
    const recent = await drifted(pat, "Recent");
    await makeOrder(recent.id, { status: "ORDER", salesPersonId: pat.id });
    const dated = await drifted(pat, "Dated");
    await setFollowUp(dated.id, dayFromToday(5));
    const contacted = await drifted(pat, "Contacted");
    await logEntry(pat.id, contacted.id, "PHONE", daysAgo(5));
    expect(ids(await suggested("pat"))).toEqual([]);
  });

  it("leaves out someone whose only order was returned or cancelled", async () => {
    await setStore({ outreachMinLifetimeSpend: 5000 });
    const pat = await makeStaff("pat");
    for (const status of ["RETURNED", "CANCELLED"] as const) {
      const client = await makeClient(status, "Client", {
        primaryDesignerId: pat.id,
        lifetimeSpend: 9000,
      });
      await makeOrder(client.id, { status, salesPersonId: pat.id, orderDate: LONG_AGO() });
    }
    expect(ids(await suggested("pat"))).toEqual([]);
  });

  it("puts each client with one person: their designer, else whoever made the last sale", async () => {
    await setStore({ outreachMinLifetimeSpend: 5000 });
    const pat = await makeStaff("pat");
    const sam = await makeStaff("sam");
    const hers = await makeClient("Nora", "Vale", {
      primaryDesignerId: pat.id,
      lifetimeSpend: 9000,
    });
    await makeOrder(hers.id, { status: "ORDER", salesPersonId: sam.id, orderDate: LONG_AGO() });
    const his = await makeClient("Otto", "Rand", { lifetimeSpend: 9000 });
    await makeOrder(his.id, { status: "ORDER", salesPersonId: pat.id, orderDate: daysAgo(900) });
    await makeOrder(his.id, { status: "ORDER", salesPersonId: sam.id, orderDate: LONG_AGO() });

    expect(ids(await suggested("pat"))).toEqual([hers.id]);
    expect(ids(await suggested("sam"))).toEqual([his.id]);
  });

  it("leaves out staff buying for themselves", async () => {
    await setStore({ outreachMinLifetimeSpend: 5000 });
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const byName = await makeClient("Pat", "Lund", { lifetimeSpend: 9000 });
    await makeOrder(byName.id, { status: "ORDER", salesPersonId: pat.id, orderDate: LONG_AGO() });
    const byEmail = await makeClient("Someone", "Else", {
      lifetimeSpend: 9000,
      email: "sam@example.com",
    });
    await makeStaff("sam");
    await makeOrder(byEmail.id, { status: "ORDER", salesPersonId: pat.id, orderDate: LONG_AGO() });
    expect(ids(await suggested("pat"))).toEqual([]);
  });
});

describe("the Follow-Ups report", () => {
  it("gives each date to its designer, else whoever set it, else the last sale", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const sam = await makeStaff("sam", "DESIGNER", "Sam Reed");
    const assigned = await makeClient("Assigned", "One", { primaryDesignerId: pat.id });
    await setFollowUp(assigned.id, "2026-11-05", "sam@example.com");
    const setBy = await makeClient("Set", "By");
    await setFollowUp(setBy.id, "2026-11-05", "sam@example.com");
    const lastSale = await makeClient("Last", "Sale");
    await setFollowUp(lastSale.id, "2026-11-05");
    await makeOrder(lastSale.id, {
      status: "ORDER",
      salesPersonId: pat.id,
      storeLocation: "Harbor",
    });
    const nobody = await makeClient("No", "One");
    await setFollowUp(nobody.id, "2026-11-05", "gone@example.com");
    const nameOnly = await makeClient("Name", "Only");
    await setFollowUp(nameOnly.id, "2026-11-05");
    await makeOrder(nameOnly.id, { status: "ORDER", salesperson: "Long Gone" });

    const rows = await loadFollowUpRows(NOON);
    const of = (id: number) => rows.find((r) => r.customerId === id);
    expect(of(assigned.id)).toMatchObject({ ownerId: pat.id, owner: "Pat Lund" });
    expect(of(setBy.id)).toMatchObject({ ownerId: sam.id, owner: "Sam Reed" });
    expect(of(lastSale.id)).toMatchObject({ ownerId: pat.id, store: "Harbor" });
    expect(of(nobody.id)).toMatchObject({ ownerId: null, owner: "No owner" });
    expect(of(nameOnly.id)).toMatchObject({ ownerId: null, owner: "Long Gone" });
  });

  it("reads due, scheduled and done, and a note doesn't make it done", async () => {
    const pat = await makeStaff("pat");
    const due = await makeClient("Due", "One", { primaryDesignerId: pat.id });
    await setFollowUp(due.id, "2026-11-05");
    await logEntry(pat.id, due.id, "NOTE", new Date("2026-11-05T11:00:00.000Z"), {
      notes: "A note",
    });
    const coming = await makeClient("Coming", "One", { primaryDesignerId: pat.id });
    await setFollowUp(coming.id, "2026-11-06");
    const done = await makeClient("Done", "One", { primaryDesignerId: pat.id });
    await setFollowUp(done.id, "2026-11-01");
    await logEntry(pat.id, done.id, "PHONE", new Date("2026-11-02T12:00:00.000Z"));

    const rows = await loadFollowUpRows(NOON);
    const of = (id: number) => rows.find((r) => r.customerId === id);
    expect(of(due.id)).toMatchObject({ status: "due", lastContact: null, lastNote: "A note" });
    expect(of(coming.id)?.status).toBe("scheduled");
    expect(of(done.id)).toMatchObject({ status: "done", lastContact: "2026-11-02" });
  });

  it("reads today and last contact by the store's clock", async () => {
    await setStore({ timezone: "Pacific/Auckland" });
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale", { primaryDesignerId: pat.id });
    // Noon UTC on the 5th is 01:00 on the 6th in Auckland, so the 6th has arrived.
    await setFollowUp(client.id, "2026-11-06");
    expect((await loadFollowUpRows(NOON))[0].status).toBe("due");
    // 11:00 UTC is already the 6th there too, so that call counts for the 6th.
    await logEntry(pat.id, client.id, "PHONE", new Date("2026-11-05T11:00:00.000Z"));
    expect((await loadFollowUpRows(NOON))[0]).toMatchObject({
      status: "done",
      lastContact: "2026-11-06",
    });
  });

  it("counts open quotes' live lines, and leaves out what's closed", async () => {
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale", { primaryDesignerId: pat.id });
    await setFollowUp(client.id, "2026-11-05");
    const quote = await makeOrder(client.id, { salesPersonId: pat.id });
    await addLine(quote.id, 100);
    await addLine(quote.id, 7000, { status: "CANCELLED" });
    await addLine(quote.id, 8000, { status: "REPLACED" });
    await addLine(quote.id, 9000, { qty: 0 });
    const archived = await makeOrder(client.id, { salesPersonId: pat.id, archived: true });
    await addLine(archived.id, 5000);
    const sold = await makeOrder(client.id, { status: "ORDER", salesPersonId: pat.id });
    await addLine(sold.id, 6000);

    expect((await loadFollowUpRows(NOON))[0]).toMatchObject({ openQuotes: 1, openQuoteValue: 100 });
  });

  it("leaves out the Cash Sale customer, and clients with no date", async () => {
    const cash = await makeClient("Cash", "Sale");
    await setFollowUp(cash.id, "2026-11-05");
    const none = await makeClient("No", "Date");
    await prisma.clientProfile.create({ data: { customerId: none.id, homes: "A place" } });
    expect(await loadFollowUpRows(NOON)).toEqual([]);
  });

  it("holds back a number that can't be called or mailed", async () => {
    const client = await makeClient("Nora", "Vale", {
      phone: "000-000-0000",
      email: "not-an-email",
    });
    await setFollowUp(client.id, "2026-11-05");
    expect((await loadFollowUpRows(NOON))[0]).toMatchObject({ phone: null, email: null });
  });

  it("counts contacts by who logged them, over 30 days, without notes", async () => {
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    const client = await makeClient("Nora", "Vale");
    const quote = await makeOrder(client.id, { salesPersonId: pat.id });
    await logEntry(pat.id, client.id, "PHONE", daysAgo(1));
    await logEntry(pat.id, client.id, "EMAIL", daysAgo(29), { salesOrderId: quote.id });
    await logEntry(pat.id, client.id, "PHONE", daysAgo(31));
    await logEntry(pat.id, client.id, "NOTE", daysAgo(1));
    await logEntry(pat.id, client.id, "MANAGER_NOTE", daysAgo(1));
    expect(await loadRecentContacts(new Date())).toEqual([
      { owner: "Pat Lund", contactsLogged: 2, aboutClientNotQuote: 1 },
    ]);
  });

  it("is for whoever manages client books", async () => {
    await makeStaff("mo", "MANAGER");
    await makeStaff("pat");
    await expect(caller("pat").reports.followUps()).rejects.toThrow(/FORBIDDEN|permission/i);
    const report = await caller("mo").reports.followUps();
    expect(report).toEqual({ rows: [], summary: [] });

    const signIn = (who: string) => {
      (getToken as jest.Mock).mockResolvedValue({ id: who });
      (headers as jest.Mock).mockResolvedValue(new Headers());
      (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
    };
    signIn("mo");
    await expect(FollowUpsPage()).resolves.toBeTruthy();
    signIn("pat");
    await expect(FollowUpsPage()).rejects.toThrow(/REDIRECT/);
  });
});

describe("quotes waiting on someone", () => {
  it("counts by the pipeline's own rules", async () => {
    const pat = await makeStaff("pat");
    const old = await makeClient("Old", "Quote");
    await makeOrder(old.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    const fresh = await makeClient("Fresh", "Quote");
    await makeOrder(fresh.id, { salesPersonId: pat.id });
    const due = await makeClient("Due", "Date");
    await makeOrder(due.id, { salesPersonId: pat.id });
    await setFollowUp(due.id, todayKey());
    const noted = await makeClient("Only", "Noted");
    await makeOrder(noted.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await logEntry(pat.id, noted.id, "NOTE", new Date());
    const notedOnQuote = await makeClient("Noted", "On Quote");
    const quoteWithNote = await makeOrder(notedOnQuote.id, {
      salesPersonId: pat.id,
      orderDate: daysAgo(30),
    });
    await logEntry(pat.id, notedOnQuote.id, "NOTE", new Date(), { salesOrderId: quoteWithNote.id });
    const called = await makeClient("Called", "Client");
    await makeOrder(called.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await logEntry(pat.id, called.id, "PHONE", new Date());
    const archived = await makeClient("Archived", "Quote");
    await makeOrder(archived.id, { salesPersonId: pat.id, orderDate: daysAgo(30), archived: true });
    const orphan = await makeClient("No", "Owner");
    await makeOrder(orphan.id, { salesperson: "Long Gone", orderDate: daysAgo(30) });

    const waiting = await countQuotesWaitingByStaff(new Date());

    expect(waiting.get(pat.id)).toBe(4); // old, due, and the two with only a note
    expect(waiting.size).toBe(1);
  });

  it("doesn't count a contact on one quote for the client's other quote", async () => {
    const pat = await makeStaff("pat");
    const client = await makeClient("Otto", "Rand");
    const called = await makeOrder(client.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await makeOrder(client.id, { salesPersonId: pat.id, orderDate: daysAgo(30) });
    await logEntry(pat.id, client.id, "PHONE", new Date(), { salesOrderId: called.id });
    expect((await countQuotesWaitingByStaff(new Date())).get(pat.id)).toBe(1);
  });

  it("goes by whichever contact was later, on the quote or about the client", async () => {
    const pat = await makeStaff("pat");
    const calledSince = await makeClient("Otto", "Rand");
    const firstQuote = await makeOrder(calledSince.id, {
      salesPersonId: pat.id,
      orderDate: daysAgo(30),
    });
    await logEntry(pat.id, calledSince.id, "PHONE", daysAgo(20), { salesOrderId: firstQuote.id });
    await logEntry(pat.id, calledSince.id, "PHONE", new Date());
    const calledOnQuote = await makeClient("Una", "Pike");
    const secondQuote = await makeOrder(calledOnQuote.id, {
      salesPersonId: pat.id,
      orderDate: daysAgo(30),
    });
    await logEntry(pat.id, calledOnQuote.id, "PHONE", daysAgo(20));
    await logEntry(pat.id, calledOnQuote.id, "PHONE", new Date(), { salesOrderId: secondQuote.id });
    expect((await countQuotesWaitingByStaff(new Date())).size).toBe(0);
  });
});

describe("the morning email", () => {
  const at = (hour: number, day = "2026-11-05") =>
    new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const sent = () => prisma.emailQueue.findMany({ orderBy: { id: "asc" } });

  async function clientDue(staffId: number) {
    const client = await makeClient("Nora", "Vale", {
      primaryDesignerId: staffId,
      phone: "202-555-0143",
    });
    await setFollowUp(client.id, "2026-11-05");
    await logEntry(staffId, client.id, "NOTE", at(1), { notes: "Wants it by spring" });
    return client;
  }

  it("is off until the store sets an hour", async () => {
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    expect(await queueFollowUpEmails(at(12))).toBe("off");
    expect(await prisma.emailQueue.count()).toBe(0);
  });

  it("goes from the store's hour, once a store day", async () => {
    await setStore({ followUpEmailHour: 9 });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);

    expect(await queueFollowUpEmails(new Date(at(9).getTime() - 60_000))).toBe("not-yet");
    expect(await prisma.emailQueue.count()).toBe(0);

    expect(await queueFollowUpEmails(at(9))).toEqual({ queued: 1, nothingToSay: 1, failed: 0 });
    expect(await queueFollowUpEmails(at(15))).toBe("already-sent");
    expect(await prisma.emailQueue.count()).toBe(1);

    const tomorrow = await queueFollowUpEmails(at(9, "2026-11-06"));
    expect(tomorrow).toMatchObject({ queued: 1 });
    expect(await prisma.emailQueue.count()).toBe(2);
  });

  it("reads the hour in the store's own time", async () => {
    await setStore({ followUpEmailHour: 9, timezone: "America/New_York" });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    expect(await queueFollowUpEmails(at(13))).toBe("not-yet"); // 8am in New York
    expect(await queueFollowUpEmails(at(14))).toMatchObject({ queued: 1 });
  });

  it("goes by the store's day, not the server's", async () => {
    await setStore({ followUpEmailHour: 9, timezone: "America/New_York" });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    // 2am UTC on the 6th is still the evening of the 5th in New York, past that day's hour.
    expect(await queueFollowUpEmails(at(2, "2026-11-06"))).toMatchObject({ queued: 1 });
    const settings = await prisma.appSettings.findUniqueOrThrow({
      where: { organizationId: DEFAULT_ORG_ID },
    });
    expect(settings.followUpEmailedOn).toBe("2026-11-05");
  });

  it("doesn't build the day's email again once it has gone", async () => {
    await setStore({ followUpEmailHour: 9 });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    await queueFollowUpEmails(at(9));
    (loadFollowUpRows as jest.Mock).mockClear();
    expect(await queueFollowUpEmails(at(15))).toBe("already-sent");
    expect(loadFollowUpRows).not.toHaveBeenCalled();
  });

  it("tells each person their own, to their own address, in the store's money", async () => {
    await setStore({
      followUpEmailHour: 9,
      outreachMinLifetimeSpend: 5000,
      companyName: "Lakeside Home",
      currency: "GBP",
      locale: "en-GB",
    });
    const pat = await makeStaff("pat", "DESIGNER", "Pat Lund");
    await makeStaff("sam", "DESIGNER", "Sam Reed");
    await clientDue(pat.id);
    const drifted = await makeClient("Otto", "Rand", {
      primaryDesignerId: pat.id,
      lifetimeSpend: 9000,
    });
    await makeOrder(drifted.id, {
      status: "ORDER",
      salesPersonId: pat.id,
      orderDate: new Date("2025-01-15T12:00:00.000Z"),
    });
    const waiting = await makeClient("Una", "Pike");
    await makeOrder(waiting.id, {
      salesPersonId: pat.id,
      orderDate: new Date("2026-10-01T12:00:00.000Z"),
    });
    const later = await makeClient("Later", "Date", { primaryDesignerId: pat.id });
    await setFollowUp(later.id, "2026-12-01");
    const reached = await makeClient("Already", "Reached", { primaryDesignerId: pat.id });
    await setFollowUp(reached.id, "2026-11-04");
    await logEntry(pat.id, reached.id, "PHONE", at(8));

    await queueFollowUpEmails(at(9));

    const emails = await sent();
    expect(emails.map((e) => e.toAddress)).toEqual(["pat@example.com"]);
    const [email] = emails;
    expect(email.templateKey).toBe("follow-up-digest");
    expect(email.subject).toContain("1 due");
    expect(email.subject).toContain("1 quote waiting");
    expect(email.subject).toContain("1 past client to call");
    expect(email.html).toContain("Lakeside Home");
    expect(email.html).toContain("Good morning Pat Lund,");
    expect(email.html).toContain("Nora Vale");
    expect(email.html).toContain("202-555-0143");
    expect(email.html).toContain("Wants it by spring");
    expect(email.html).toContain("5 Nov");
    expect(email.html).toContain("Otto Rand");
    expect(email.html).toContain("£9,000 lifetime");
    expect(email.html).toContain("£5,000");
    expect(email.html).toContain("Jan 2025");
    expect(email.html).toContain("no order in 12 months and no contact in 90 days");
    expect(email.html).not.toContain("Later Date");
    expect(email.html).not.toContain("Already Reached");
  });

  it("doesn't suggest anyone when the store hasn't asked", async () => {
    await setStore({ followUpEmailHour: 9 });
    const pat = await makeStaff("pat");
    const drifted = await makeClient("Otto", "Rand", {
      primaryDesignerId: pat.id,
      lifetimeSpend: 90000,
    });
    await makeOrder(drifted.id, {
      status: "ORDER",
      salesPersonId: pat.id,
      orderDate: daysAgo(900),
    });
    expect(await queueFollowUpEmails(at(9))).toMatchObject({ queued: 0 });
  });

  it("sends nobody an empty one, or one they turned off", async () => {
    await setStore({ followUpEmailHour: 9 });
    await makeStaff("pat");
    const off = await makeStaff("off");
    await clientDue(off.id);
    await caller("off").account.setFollowUpEmail({ on: false });
    // pat and the owner have nothing to say. off isn't asked.
    expect(await queueFollowUpEmails(at(9))).toEqual({ queued: 0, nothingToSay: 2, failed: 0 });
  });

  it("turning it back on works, and the setting belongs to each person", async () => {
    const off = await makeStaff("off");
    const other = await makeStaff("other");
    await caller("off").account.setFollowUpEmail({ on: false });
    const read = (id: number) =>
      prisma.staffMember.findUniqueOrThrow({ where: { id } }).then((s) => s.followUpEmailOff);
    expect(await read(off.id)).toBe(true);
    expect(await read(other.id)).toBe(false);
    await caller("off").account.setFollowUpEmail({ on: true });
    expect(await read(off.id)).toBe(false);
  });

  it("leaves out people who've left, roles with no clients, and no address", async () => {
    await setStore({ followUpEmailHour: 9, outreachMinLifetimeSpend: 5000 });
    const gone = await makeStaff("gone");
    await clientDue(gone.id);
    // Their last sale is still theirs in the book, so only being inactive keeps this back.
    const stillInTheirBook = await makeClient("Otto", "Rand", { lifetimeSpend: 9000 });
    await makeOrder(stillInTheirBook.id, {
      status: "ORDER",
      salesPersonId: gone.id,
      orderDate: new Date("2025-01-15T12:00:00.000Z"),
    });
    await prisma.staffMember.update({ where: { id: gone.id }, data: { isActive: false } });
    const wes = await makeStaff("wes", "WAREHOUSE");
    const toWes = await makeClient("To", "Wes", { primaryDesignerId: wes.id });
    await setFollowUp(toWes.id, "2026-11-05");
    const none = await makeStaff("none");
    const toNone = await makeClient("To", "None", { primaryDesignerId: none.id });
    await setFollowUp(toNone.id, "2026-11-05");
    await prisma.staffMember.update({ where: { id: none.id }, data: { email: null } });

    // Only the owner was asked, and has nothing to say.
    expect(await queueFollowUpEmails(at(9))).toEqual({ queued: 0, nothingToSay: 1, failed: 0 });
    expect(await prisma.emailQueue.count()).toBe(0);
  });

  it("two runs at once send one set", async () => {
    await setStore({ followUpEmailHour: 9 });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    const results = await Promise.all([queueFollowUpEmails(at(9)), queueFollowUpEmails(at(9))]);
    expect(await prisma.emailQueue.count()).toBe(1);
    expect(results).toContain("already-sent");
  });

  it("if queuing fails, nothing went, and the next run tries again", async () => {
    await setStore({ followUpEmailHour: 9 });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    (enqueueEmail as jest.Mock).mockRejectedValueOnce(new Error("queue is down"));
    await expect(queueFollowUpEmails(at(9))).rejects.toThrow("queue is down");
    expect(await prisma.emailQueue.count()).toBe(0);
    expect(await queueFollowUpEmails(at(10))).toMatchObject({ queued: 1 });
  });

  it("if queuing fails partway, the ones before it don't go either", async () => {
    await setStore({ followUpEmailHour: 9 });
    const pat = await makeStaff("pat");
    await clientDue(pat.id);
    const sam = await makeStaff("sam");
    await clientDue(sam.id);
    (enqueueEmail as jest.Mock)
      .mockImplementationOnce(jest.requireActual("@/lib/email/queue").enqueueEmail)
      .mockRejectedValueOnce(new Error("queue is down"));
    await expect(queueFollowUpEmails(at(9))).rejects.toThrow("queue is down");
    expect(await prisma.emailQueue.count()).toBe(0);
    expect(await queueFollowUpEmails(at(10))).toMatchObject({ queued: 2 });
  });

  it("goes out through the email cron", async () => {
    await setStore({ followUpEmailHour: 0 });
    const pat = await makeStaff("pat");
    const client = await makeClient("Nora", "Vale", { primaryDesignerId: pat.id });
    await setFollowUp(client.id, todayKey());
    const old = process.env.AUTO_IMPORT_API_KEY;
    process.env.AUTO_IMPORT_API_KEY = "test-key";
    const res = await call(emailQueueRoute, "pat", {
      method: "POST",
      authorization: "Bearer test-key",
    });
    process.env.AUTO_IMPORT_API_KEY = old;
    expect(res.status).toBe(200);
    expect(res.body.followUps).toMatchObject({ queued: 1 });
  });

  it("a person's morning email setting shows on My Clients only when the store sends one", async () => {
    const pat = await makeStaff("pat");
    const state = async () => (await call(clientsRoute, "pat")).body.morningEmailOn;
    expect(await state()).toBeNull();
    await setStore({ followUpEmailHour: 9 });
    expect(await state()).toBe(true);
    await prisma.staffMember.update({ where: { id: pat.id }, data: { followUpEmailOff: true } });
    expect(await state()).toBe(false);
  });
});

describe("the settings", () => {
  const put = (body: object) => call(settingsRoute, "owner", { method: "PUT", body });

  it("saves and shows them, and empty turns each back off", async () => {
    const saved = await put({
      followUpEmailHour: 7,
      outreachMinLifetimeSpend: 4000,
      outreachLapsedMonths: 18,
      outreachQuietDays: 45,
    });
    expect(saved.status).toBe(200);
    const { settings } = (await call(settingsRoute, "owner")).body;
    expect(settings).toMatchObject({
      followUpEmailHour: 7,
      outreachMinLifetimeSpend: 4000,
      outreachLapsedMonths: 18,
      outreachQuietDays: 45,
    });
    await put({
      followUpEmailHour: null,
      outreachMinLifetimeSpend: null,
      outreachLapsedMonths: null,
      outreachQuietDays: null,
    });
    expect((await call(settingsRoute, "owner")).body.settings).toMatchObject({
      followUpEmailHour: null,
      outreachMinLifetimeSpend: null,
      outreachLapsedMonths: null,
      outreachQuietDays: null,
    });
  });

  it.each([
    [{ followUpEmailHour: 24 }, /hour/],
    [{ followUpEmailHour: -1 }, /hour/],
    [{ followUpEmailHour: 7.5 }, /hour/],
    [{ followUpEmailHour: "7" }, /hour/],
    [{ outreachMinLifetimeSpend: 0 }, /Lifetime spend/],
    [{ outreachMinLifetimeSpend: "5000" }, /Lifetime spend/],
    [{ outreachLapsedMonths: 0 }, /Months/],
    [{ outreachLapsedMonths: 121 }, /Months/],
    [{ outreachQuietDays: 0 }, /Days/],
    [{ outreachQuietDays: 3651 }, /Days/],
  ])("refuses %j with the reason", async (body, reason) => {
    const refused = await put(body);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(reason);
  });

  it("the database refuses them too", async () => {
    await expect(setStore({ followUpEmailHour: 24 })).rejects.toThrow();
    await expect(setStore({ outreachMinLifetimeSpend: 0 })).rejects.toThrow();
    await expect(setStore({ outreachLapsedMonths: 0 })).rejects.toThrow();
    await expect(setStore({ outreachQuietDays: 0 })).rejects.toThrow();
  });
});

describe("My Clients' link from the email", () => {
  it("opens on the view it names, and All for anything else", async () => {
    await makeStaff("pat");
    (getToken as jest.Mock).mockResolvedValue({ id: "pat" });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
    const view = async (show?: string) =>
      (await ClientsPage({ searchParams: Promise.resolve({ show }) })).props.linkedView;
    expect(await view("due")).toBe("due");
    expect(await view("suggested")).toBe("suggested");
    expect(await view("nonsense")).toBe("all");
    expect(await view()).toBe("all");
  });
});
