// /app/__tests__/integration/upboardRoster.integration.test.ts
//
// The Up Board's Sign In panel lists who can be signed in from its own roster
// (GET /api/upboard/roster, staff.self, the same key as clock-in). It used to
// read GET /api/staff ("Manage staff"), so for designers and every other role
// without that key the panel came up empty and said "All designers are signed
// in". Real route, real permission gate, real database; next-auth's session is
// the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import rosterRoute from "@/pages/api/upboard/roster";

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

async function call(method = "GET"): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await rosterRoute({ method, query: {}, body: {}, cookies: {} } as any, res);
  return res;
}

async function makeStaff(userId: string, roleKey: string, isActive = true) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: roleKey as any,
      roleId: role.id,
      isActive,
    },
  });
}

async function setUpBoard(on: boolean) {
  await prisma.appSettings.upsert({
    where: { organizationId: 1 },
    update: { features: { upBoard: on } },
    create: { organizationId: 1, appName: "Test Co", features: { upBoard: on } },
  });
  invalidateAppSettingsCache();
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  await setUpBoard(true);
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
  await makeStaff("dana", "DESIGNER");
  await makeStaff("gone", "DESIGNER", false);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the Up Board roster", () => {
  it("a designer (no Manage staff) gets the active staff: id, name and role only", async () => {
    sessionMock.mockResolvedValue({ user: { id: "dana", email: "dana@example.com" } });

    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.map((s: { displayName: string }) => s.displayName)).toEqual(["admin", "dana"]);
    for (const s of res.body) {
      expect(Object.keys(s).sort()).toEqual(["displayName", "id", "role"]);
    }
    expect(JSON.stringify(res.body)).not.toContain("@example.com");
  });

  it("is refused to a deactivated staff member and answers only GET", async () => {
    sessionMock.mockResolvedValue({ user: { id: "gone", email: "gone@example.com" } });
    expect((await call()).statusCode).toBe(403);

    sessionMock.mockResolvedValue({ user: { id: "dana", email: "dana@example.com" } });
    expect((await call("POST")).statusCode).toBe(405);
  });

  it("is not there when the Up Board module is off", async () => {
    await setUpBoard(false);
    sessionMock.mockResolvedValue({ user: { id: "dana", email: "dana@example.com" } });

    expect((await call()).statusCode).toBe(404);
  });
});
