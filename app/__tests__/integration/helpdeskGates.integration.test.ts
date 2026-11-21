// /app/__tests__/integration/helpdeskGates.integration.test.ts
//
// The helpdesk answers to the service keys (the 2026-11 role-list sweep): the
// queue, a ticket and the ticket page on "View service" (service.read), and
// replying, attaching a file and triage on "Work service" (service.write).
// Before, the ticket page and its four routes took SUPER_ADMIN/ADMIN/MANAGER
// role lists (attachments added DESIGNER), so a Customer Service rep, whose job
// is tickets, saw the Helpdesk link and the queue page and was refused every
// ticket. Real routes, real gates, real database; only the session readers and
// redirect are mocked.

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
import ticketsRoute from "@/pages/api/tickets/index";
import ticketRoute from "@/pages/api/tickets/[id]";
import messagesRoute from "@/pages/api/tickets/[id]/messages";
import attachmentsRoute from "@/pages/api/tickets/[id]/attachments";
import TicketPage from "@/app/(dashboard)/app/helpdesk/[id]/page";

const sessionMock = getServerSession as jest.Mock;

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

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
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as TestRes;
}

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<TestRes> {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
  const res = makeRes();
  await route({ method, query, body, headers: {}, cookies: {} } as unknown as NextApiRequest, res);
  return res;
}

/** Does the ticket page let this person in? It redirects home when it doesn't. */
async function opensTicketPage(userId: string, ticketId: number): Promise<boolean> {
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (headers as jest.Mock).mockResolvedValue(new Headers());
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  try {
    await TicketPage({ params: Promise.resolve({ id: String(ticketId) }) });
    return true;
  } catch (e) {
    if (e instanceof Error && e.message === "REDIRECT /app") return false;
    throw e;
  }
}

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

/** A signed-in staff member holding a built-in role (enum and roleId agree). */
async function makeStaff(userId: string, roleKey: string) {
  await makeUser(userId);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

/** A staff member on a role built in Roles; the enum is DESIGNER, as role assignment writes. */
async function makeCustomRoleStaff(userId: string, permissions: string[]) {
  await makeUser(userId);
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${userId.toUpperCase()}`,
      name: `Custom ${userId}`,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

let ticketId: number;
const ticketQuery = () => ({ id: String(ticketId) });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  invalidateAppSettingsCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("ada", "ADMIN");
  const ticket = await prisma.ticket.create({
    data: {
      organizationId: DEFAULT_ORG_ID,
      ticketNumber: "TKT-261121-001",
      publicToken: "helpdesk-gates-status-token",
      submitterName: "Rowan Vale",
      submitterEmail: "rowan@example.com",
      subject: "The sofa leg is loose",
      messages: { create: { authorName: "Rowan Vale", body: "One leg wobbles." } },
    },
  });
  ticketId = ticket.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the queue, a ticket and the ticket page follow View service", () => {
  it("a Customer Service rep opens the queue, the ticket and its page", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");

    const queue = await call(ticketsRoute, "cara");
    expect(queue.statusCode).toBe(200);
    expect(queue.body.tickets.map((t: { subject: string }) => t.subject)).toEqual([
      "The sofa leg is loose",
    ]);

    const one = await call(ticketRoute, "cara", { query: ticketQuery() });
    expect(one.statusCode).toBe(200);
    expect(one.body.ticket.subject).toBe("The sofa leg is loose");

    expect(await opensTicketPage("cara", ticketId)).toBe(true);
  });

  it("a role without it is refused the queue, the ticket and the page", async () => {
    await makeStaff("reg", "REGISTER");

    expect((await call(ticketsRoute, "reg")).statusCode).toBe(403);
    expect((await call(ticketRoute, "reg", { query: ticketQuery() })).statusCode).toBe(403);
    expect(await opensTicketPage("reg", ticketId)).toBe(false);
  });

  it("the Owner and a Manager keep them", async () => {
    await makeStaff("sam", "SUPER_ADMIN");
    await makeStaff("mia", "MANAGER");

    for (const who of ["sam", "mia"]) {
      expect({ who, status: (await call(ticketsRoute, who)).statusCode }).toEqual({
        who,
        status: 200,
      });
      expect({
        who,
        status: (await call(ticketRoute, who, { query: ticketQuery() })).statusCode,
      }).toEqual({ who, status: 200 });
      expect({ who, opens: await opensTicketPage(who, ticketId) }).toEqual({ who, opens: true });
    }
  });
});

describe("replying, attaching a file and triage follow Work service", () => {
  it("a Customer Service rep adds a note and changes the priority", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");

    const note = await call(messagesRoute, "cara", {
      method: "POST",
      query: ticketQuery(),
      body: { body: "Called the customer back.", isInternal: true },
    });
    expect(note.statusCode).toBe(201);
    expect(await prisma.ticketMessage.count({ where: { ticketId } })).toBe(2);

    const triage = await call(ticketRoute, "cara", {
      method: "PATCH",
      query: ticketQuery(),
      body: { priority: "HIGH" },
    });
    expect(triage.statusCode).toBe(200);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).priority).toBe(
      "HIGH",
    );
  });

  it("gets past the attachment gate, to the ticket lookup behind it", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");
    await makeStaff("reg", "REGISTER");

    // A ticket that does not exist answers before the upload is read, so the
    // 404 shows the gate let the rep through.
    const missing = { id: String(ticketId + 1000) };
    const admitted = await call(attachmentsRoute, "cara", { method: "POST", query: missing });
    expect(admitted.statusCode).toBe(404);
    expect(admitted.body.error).toBe("Ticket not found");

    const refused = await call(attachmentsRoute, "reg", { method: "POST", query: missing });
    expect(refused.statusCode).toBe(403);
  });

  it("a role that may only view tickets reads one but cannot reply, attach or triage", async () => {
    await makeCustomRoleStaff("vic", ["service.read"]);

    expect((await call(ticketRoute, "vic", { query: ticketQuery() })).statusCode).toBe(200);

    const triage = await call(ticketRoute, "vic", {
      method: "PATCH",
      query: ticketQuery(),
      body: { priority: "HIGH" },
    });
    expect(triage.statusCode).toBe(403);
    expect(triage.body.error).toBe("Updating a ticket needs the Work service permission.");

    const note = await call(messagesRoute, "vic", {
      method: "POST",
      query: ticketQuery(),
      body: { body: "Should not land.", isInternal: true },
    });
    expect(note.statusCode).toBe(403);

    const attach = await call(attachmentsRoute, "vic", { method: "POST", query: ticketQuery() });
    expect(attach.statusCode).toBe(403);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.priority).toBe("MEDIUM");
    expect(await prisma.ticketMessage.count({ where: { ticketId } })).toBe(1);
  });
});
