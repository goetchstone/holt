// /app/__tests__/integration/tillReadGate.integration.test.ts
//
// SEC-13 tranche 3: till detail and running totals answer to the till pages'
// own key, sales.read ("View orders"), so the owner's Roles settings decide who
// reads them. Before, any signed-in session read every till. Real routes, real
// permission gate, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
// The routes before this change read the session through next-auth/next. The
// same mock answers there, so reverting a route shows its real behaviour
// (a 200 for anyone) instead of a 401 from an unmocked import.
jest.mock("next-auth/next", () => ({
  getServerSession: (...args: unknown[]) => jest.requireMock("next-auth").getServerSession(...args),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import tillRoute from "@/pages/api/tills/[id]";
import tillSummaryRoute from "@/pages/api/tills/[id]/summary";

const sessionMock = getServerSession as jest.Mock;

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

async function get(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  id: number,
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method: "GET", query: { id: String(id) }, body: {}, cookies: {} } as any;
  await route(req, res);
  return res;
}

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

/** A signed-in staff member holding a built-in role (enum and roleId agree). */
async function makeStaff(userId: string, roleKey: string) {
  await makeUser(userId);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: roleKey as any, roleId: role.id },
  });
}

/** A staff member on a role built in Roles; the enum is DESIGNER, as USE-02 writes. */
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

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

let tillId: number;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
  const opener = await makeStaff("cass", "REGISTER");
  const store = await prisma.storeLocation.create({
    data: { name: "Main", code: "MAIN", type: "STORE" },
  });
  const register = await prisma.register.create({
    data: {
      name: "Front Desk",
      storeLocationId: store.id,
      blockReason: "an earlier variance note",
      createdBy: "setup@example.com",
    },
  });
  const till = await prisma.till.create({
    data: {
      registerId: register.id,
      status: "OPEN",
      openedById: opener.id,
      openingCash: 200,
      createdBy: "cass@example.com",
    },
  });
  tillId = till.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("till reads follow the till pages' key (sales.read)", () => {
  it("a role without View orders gets 403 from both routes", async () => {
    await makeStaff("hana", "HR");
    signInAs("hana");

    expect((await get(tillRoute, tillId)).statusCode).toBe(403);
    expect((await get(tillSummaryRoute, tillId)).statusCode).toBe(403);
  });

  it("a role with View orders reads both", async () => {
    await makeStaff("mo", "MANAGER");
    signInAs("mo");

    const detail = await get(tillRoute, tillId);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.openingCash).toBe(200);
    expect(detail.body.register).toEqual({ name: "Front Desk", storeLocation: { name: "Main" } });

    const summary = await get(tillSummaryRoute, tillId);
    expect(summary.statusCode).toBe(200);
    expect(summary.body.openingCash).toBe(200);
  });

  it("a custom role follows its Roles grants, not its DESIGNER enum", async () => {
    await makeCustomRoleStaff("lee", ["sales.read"]);
    await makeCustomRoleStaff("kim", ["catalog.read"]);

    signInAs("lee");
    expect((await get(tillRoute, tillId)).statusCode).toBe(200);
    expect((await get(tillSummaryRoute, tillId)).statusCode).toBe(200);

    signInAs("kim");
    expect((await get(tillRoute, tillId)).statusCode).toBe(403);
    expect((await get(tillSummaryRoute, tillId)).statusCode).toBe(403);
  });

  it("till detail carries what the page shows, not staff emails or register notes", async () => {
    await makeStaff("mo", "MANAGER");
    signInAs("mo");

    const { body } = await get(tillRoute, tillId);

    expect(Object.keys(body).sort()).toEqual(
      [
        "actualCash",
        "closedAt",
        "closedBy",
        "counts",
        "expectedCash",
        "id",
        "notes",
        "openedAt",
        "openedBy",
        "openingCash",
        "payments",
        "register",
        "status",
        "variance",
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("@example.com");
    expect(JSON.stringify(body)).not.toContain("variance note");
  });
});
