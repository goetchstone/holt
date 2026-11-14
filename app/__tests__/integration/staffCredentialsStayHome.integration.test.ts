// /app/__tests__/integration/staffCredentialsStayHome.integration.test.ts
//
// A staff member's password hash and register PIN hash never leave the server.
// The data export carried pinHash (lib/genericExport.ts now names its columns),
// and the same shape sat in the routes that answer with a staff row: the staff
// list and record (an `include` returns every column), an installer's linked
// staff member and a delivery run's driver (`staffMember: true`, `driver: true`).
// Each now names the columns it sends (lib/staffRecord.ts, or id + name).
//
// Real routes and database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { hashPassword, hashPin } from "@/lib/auth/password";
import staffListRoute from "@/pages/api/staff/index";
import staffRoute from "@/pages/api/staff/[id]";
import installersRoute from "@/pages/api/service/installers/index";
import installerRoute from "@/pages/api/service/installers/[id]";
import runsRoute from "@/pages/api/dispatch/runs/index";
import runRoute from "@/pages/api/dispatch/runs/[id]";

const sessionMock = getServerSession as jest.Mock;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: unknown;
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

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string> = {},
  body: unknown = {},
) {
  const res = makeRes();
  await route({ method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest, res);
  return res;
}

/** No credential column, and no scrypt hash under any name. */
function expectNoCredentials(res: TestRes) {
  expect(res.statusCode).toBeLessThan(300);
  const text = JSON.stringify(res.body);
  expect(text).not.toMatch(/passwordHash|pinHash|pinFailedAttempts|pinLockedUntil/);
  expect(text).not.toMatch(/scrypt\$/);
}

let driverId: number;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  const owner = await prisma.staffMember.create({
    data: {
      userId: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      role: "ADMIN",
      roleId: role.id,
      passwordHash: hashPassword("correct horse battery staple"),
      pinHash: hashPin("4821"),
    },
  });
  driverId = owner.id;
  sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("staff credentials stay on the server", () => {
  it("the staff list, and a new staff member", async () => {
    const list = await call(staffListRoute, "GET", { all: "true" });
    expectNoCredentials(list);
    expect(list.body).toEqual([
      expect.objectContaining({ id: driverId, displayName: "Owner", role: "ADMIN" }),
    ]);

    expectNoCredentials(await call(staffListRoute, "POST", {}, { displayName: "New Hire" }));
  });

  it("a staff record: read, edit and deactivate", async () => {
    // A second admin, so deactivating the owner is allowed.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    const other = await prisma.staffMember.create({
      data: {
        displayName: "Second",
        role: "ADMIN",
        roleId: role.id,
        pinHash: hashPin("1234"),
        passwordHash: hashPassword("another long passphrase"),
      },
    });
    const id = String(other.id);

    const read = await call(staffRoute, "GET", { id });
    expectNoCredentials(read);
    expect(read.body).toMatchObject({ id: other.id, displayName: "Second", isActive: true });

    expectNoCredentials(await call(staffRoute, "PATCH", { id }, { displayName: "Second Admin" }));
    expectNoCredentials(await call(staffRoute, "DELETE", { id }));
  });

  it("an installer's linked staff member", async () => {
    const created = await call(
      installersRoute,
      "POST",
      {},
      { name: "Crew A", staffMemberId: String(driverId) },
    );
    expectNoCredentials(created);
    expect(created.body).toMatchObject({ staffMember: { id: driverId, displayName: "Owner" } });

    const installerId = String((created.body as { id: number }).id);
    expectNoCredentials(await call(installersRoute, "GET"));
    expectNoCredentials(await call(installerRoute, "GET", { id: installerId }));
    expectNoCredentials(
      await call(installerRoute, "PUT", { id: installerId }, { notes: "Weekends" }),
    );
  });

  it("a delivery run's driver", async () => {
    const vehicle = await prisma.vehicle.create({ data: { name: "Truck 1" } });
    const run = await prisma.deliveryRun.create({
      data: {
        runNumber: "R-1",
        runDate: new Date("2026-11-14T12:00:00Z"),
        vehicleId: vehicle.id,
        driverId,
      },
    });

    const list = await call(runsRoute, "GET", { date: "2026-11-14" });
    expectNoCredentials(list);
    expect((list.body as { runs: unknown[] }).runs).toEqual([
      expect.objectContaining({ driver: { id: driverId, displayName: "Owner" } }),
    ]);
    expectNoCredentials(await call(runRoute, "GET", { id: String(run.id) }));
    expectNoCredentials(
      await call(runRoute, "PUT", { id: String(run.id) }, { notes: "Back door" }),
    );
  });
});
