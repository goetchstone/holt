// /app/__tests__/integration/genericExport.integration.test.ts
//
// The data export, against Postgres. The Staff CSV used to carry
// StaffMember.pinHash: the runner read every column and stripped a short list of
// known secret names, and pinHash was not on it. Each entity now selects only
// the columns lib/genericExport.ts allows; __tests__/genericExportColumns.test.ts
// holds that list to the schema, and this proves what actually goes out.

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
import { EXPORT_ENTITIES, getExportEntity } from "@/lib/genericExport";
import { runGenericExport } from "@/lib/genericExportRunner";
import exportRoute from "@/pages/api/admin/export/[entity]";

const sessionMock = getServerSession as jest.Mock;

function makeRes() {
  let statusCode = 0;
  let body: unknown = undefined;
  const res = {
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    send(payload: unknown) {
      body = payload;
      return res;
    },
    end(payload?: unknown) {
      body = payload;
      return res;
    },
    setHeader() {},
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: roleKey as never,
      roleId: role?.id ?? null,
      passwordHash: await hashPassword("correct horse battery staple"),
      pinHash: await hashPin("4821"),
      pinFailedAttempts: 2,
    },
  });
}

const STAFF_COLUMNS = getExportEntity("staff")!.columns;

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  sessionMock.mockReset();
});

describe("data export (real DB)", () => {
  it("exports staff without a password or PIN hash, and with every allowed column", async () => {
    const staff = await makeStaff("admin1", "ADMIN");
    // The fixture really holds the secrets the export must not carry.
    expect(staff.pinHash).toBeTruthy();
    expect(staff.passwordHash).toBeTruthy();

    const rows = await runGenericExport("staff");

    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]);
    expect(keys).not.toContain("pinHash");
    expect(keys).not.toContain("passwordHash");
    expect(keys).not.toContain("pinFailedAttempts");
    expect(keys).not.toContain("pinLockedUntil");
    expect([...keys].sort()).toEqual([...STAFF_COLUMNS].sort());
    expect(rows[0]).toMatchObject({ id: staff.id, displayName: "admin1", userId: "admin1" });
  });

  it("serves the Staff CSV through the route with the allowed header and no hash", async () => {
    await makeStaff("admin1", "ADMIN");
    sessionMock.mockResolvedValue({ user: { id: "admin1" } });

    const res = makeRes();
    await exportRoute(
      {
        method: "GET",
        query: { entity: "staff" },
        body: {},
        cookies: {},
      } as unknown as NextApiRequest,
      res,
    );

    expect(res.statusCode).toBe(200);
    const csv = String(res.body);
    const header = csv.split("\r\n")[0].split(",");
    expect([...header].sort()).toEqual([...STAFF_COLUMNS].sort());
    expect(csv).not.toMatch(/scrypt|pinHash|passwordHash/i);
  });

  it("runs every entity's select against the real schema", async () => {
    // Prisma rejects an unknown select field whether or not the table has rows,
    // so an empty database is enough to prove every column list is valid.
    for (const entity of EXPORT_ENTITIES) {
      await expect(runGenericExport(entity.key)).resolves.toEqual(expect.any(Array));
    }
  });
});
