// /app/__tests__/integration/storeTrafficGate.integration.test.ts
//
// SEC-13 tranche 3: the home page's store traffic answers to "View store
// traffic" (reporting.traffic), a switch the owner sets per role in Roles, and
// the one-time migration keeps it on for edited and custom roles, which the
// deploy seeder never touches. Before, any signed-in session read it. Real
// route, real permission gate, real database; next-auth's session and the
// Axper HTTP client are the only mocks.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
// The route read the session through next-auth/next before this change. The
// same mock answers there, so reverting it shows its real behaviour.
jest.mock("next-auth/next", () => ({
  getServerSession: (...args: unknown[]) => jest.requireMock("next-auth").getServerSession(...args),
}));
jest.mock("@/lib/axperClient", () => ({ fetchAxperTraffic: jest.fn() }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { fetchAxperTraffic } from "@/lib/axperClient";
import trafficRoute from "@/pages/api/axper/traffic/index";

const sessionMock = getServerSession as jest.Mock;
const axperMock = fetchAxperTraffic as jest.Mock;

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../prisma/migrations/20260924120000_grant_reporting_traffic/migration.sql"),
  "utf8",
);

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
  query: Record<string, string> = { dateFrom: "2026-09-24", dateTo: "2026-09-24" },
  method = "GET",
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method, query, body: {}, cookies: {} } as any;
  await trafficRoute(req, res);
  return res;
}

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

async function makeStaff(userId: string, roleKey: string) {
  await makeUser(userId);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: roleKey as any, roleId: role.id },
  });
}

async function customRole(key: string, permissions: string[]) {
  return prisma.role.create({
    data: {
      key,
      name: key,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
}

async function makeCustomRoleStaff(userId: string, permissions: string[]) {
  await makeUser(userId);
  const role = await customRole(`CUSTOM_${userId.toUpperCase()}`, permissions);
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

async function grants(roleKey: string): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { permissions: { select: { permission: true } } },
  });
  return role.permissions.map((p) => p.permission);
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  axperMock.mockReset();
  axperMock.mockResolvedValue([
    {
      store_number: "1",
      store_name: "Main",
      local_time: "2026-09-24 10:00",
      entries: 12,
      exits: 9,
    },
  ]);
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  await prisma.appSettings.create({
    data: { organizationId: 1, appName: "Test Co", features: { storeTraffic: true } },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("store traffic follows View store traffic", () => {
  it("every built-in role holds it on day one, so nobody loses the figures", async () => {
    for (const key of ["HR", "BUYER", "MARKETING", "DESIGNER", "REGISTER", "INSTALLER"]) {
      const userId = `u-${key.toLowerCase()}`;
      await makeStaff(userId, key);
      signInAs(userId);
      expect({ key, status: (await call()).statusCode }).toEqual({ key, status: 200 });
    }
  });

  it("a role without it gets 403, and Axper is never asked", async () => {
    await makeCustomRoleStaff("kim", ["catalog.read"]);
    signInAs("kim");

    expect((await call()).statusCode).toBe(403);
    expect(axperMock).not.toHaveBeenCalled();
  });

  it("a custom role holding it reads the figures", async () => {
    await makeCustomRoleStaff("lee", ["reporting.traffic"]);
    signInAs("lee");

    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body[0]).toMatchObject({ store_name: "Main", entries: 12 });
  });
});

describe("the route checks its input before anything reaches Axper or the logs", () => {
  beforeEach(async () => {
    await makeStaff("mo", "MANAGER");
    signInAs("mo");
  });

  it.each([
    [{ dateFrom: "yesterday", dateTo: "2026-09-24" }],
    [{ dateFrom: "2026-02-30", dateTo: "2026-02-30" }],
    [{ dateFrom: "2026-09-24" }],
    [{ dateFrom: "2026-09-25", dateTo: "2026-09-24" }],
  ])("refuses %j with 400", async (query) => {
    const res = await call(query as Record<string, string>);
    expect(res.statusCode).toBe(400);
    expect(axperMock).not.toHaveBeenCalled();
  });

  it("answers only GET", async () => {
    expect((await call(undefined, "POST")).statusCode).toBe(405);
  });
});

describe("migration 20260924120000 keeps the figures for roles the seeder never touches", () => {
  it("grants edited built-in roles and custom roles, not wildcard roles, and is idempotent", async () => {
    // An owner edited MANAGER (the seeder now leaves its grants alone) before
    // this key existed, and built a role of their own.
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.role.update({ where: { id: manager.id }, data: { grantsCustomized: true } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: manager.id, permission: "reporting.traffic" },
    });
    await customRole("FLOOR_LEAD", ["sales.read"]);
    expect(await grants("MANAGER")).not.toContain("reporting.traffic");
    expect(await grants("FLOOR_LEAD")).not.toContain("reporting.traffic");

    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    await prisma.$executeRawUnsafe(MIGRATION_SQL);

    expect((await grants("MANAGER")).filter((p) => p === "reporting.traffic")).toHaveLength(1);
    expect((await grants("FLOOR_LEAD")).filter((p) => p === "reporting.traffic")).toHaveLength(1);
    expect(await grants("SUPER_ADMIN")).toEqual([]);
  });
});
