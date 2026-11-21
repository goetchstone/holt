// /app/__tests__/integration/ownerTierEscalation.integration.test.ts
//
// Two doors to the owner tier that staff.manage alone left open, until
// 2026-11-20. General Managers and People Operations hold staff.manage
// ("Create staff and assign roles"), and USE-02 had already ruled that only an
// admin assigns roles and only an owner assigns the owner tier. But:
//
//   - POST /api/admin/staff/[id]/set-password checked only staff.manage, so a
//     General Manager could set an Administrator's or the Owner's password and
//     sign in as them;
//   - the roles API (/api/admin/roles, /api/admin/roles/[id]) checked only
//     staff.manage, so People Operations could add admin keys, or the
//     owner-only ones, to their own role.
//
// Both now take what assigning a role takes (lib/auth/roleAssignment.ts). Real
// database, real gates: each refusal is asserted with nothing written.

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
import rolesIndexRoute from "@/pages/api/admin/roles/index";
import roleByIdRoute from "@/pages/api/admin/roles/[id]";
import setPasswordRoute from "@/pages/api/admin/staff/[id]/set-password";

const sessionMock = getServerSession as jest.Mock;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  return {
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
    end(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TestRes;
}

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "GET", query: {}, body: {}, cookies: {}, ...over } as any;
}

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  over: Partial<NextApiRequest>,
): Promise<TestRes> {
  const res = makeRes();
  await route(makeReq(over), res);
  return res;
}

/** A signed-in staff member on a built-in role (enum and Role row agree). */
async function makeStaff(userId: string, roleKey: string, email = `${userId}@example.com`) {
  await prisma.user.create({ data: { id: userId, email } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      email,
      displayName: userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: (role.isSystem ? roleKey : "DESIGNER") as any,
      roleId: role.id,
    },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
  invalidateRoleGrantCache();
}

async function grantsOf(roleKey: string): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { permissions: { select: { permission: true } } },
  });
  return role.permissions.map((p) => p.permission).sort();
}

const setPassword = (staffId: number) =>
  call(setPasswordRoute, {
    method: "POST",
    query: { id: String(staffId) },
    body: { password: "a-long-enough-password" },
  });

let owner: { id: number };
let admin: { id: number };
let designer: { id: number };

beforeEach(async () => {
  await resetTestDb();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  owner = await makeStaff("owner", "SUPER_ADMIN");
  admin = await makeStaff("admin", "ADMIN");
  await makeStaff("gm", "GENERAL_MANAGER");
  await makeStaff("hr", "HR");
  designer = await makeStaff("designer", "DESIGNER");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("set-password: setting someone's password is assigning their role", () => {
  it.each(["gm", "hr"])(
    "refuses %s, who holds staff.manage, for anyone, and writes nothing",
    async (who) => {
      signInAs(who);
      for (const target of [owner, admin, designer]) {
        const res = await setPassword(target.id);
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toMatch(/only an admin/i);
      }
      const hashes = await prisma.staffMember.findMany({ where: { passwordHash: { not: null } } });
      expect(hashes).toEqual([]);
    },
  );

  it("lets an admin set an ordinary member's password", async () => {
    signInAs("admin");
    const res = await setPassword(designer.id);
    expect(res.statusCode).toBe(200);
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: designer.id } });
    expect(row.passwordHash).toBeTruthy();
  });

  it("keeps the Owner's password from an admin", async () => {
    signInAs("admin");
    const res = await setPassword(owner.id);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only an owner/i);
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).toBeNull();
  });

  it("lets the Owner set an admin's password", async () => {
    signInAs("owner");
    const res = await setPassword(admin.id);
    expect(res.statusCode).toBe(200);
  });
});

describe("the roles API: changing what a role can do", () => {
  it("refuses People Operations adding admin keys to its own role, and writes nothing", async () => {
    signInAs("hr");
    const hrRole = await prisma.role.findUniqueOrThrow({ where: { key: "HR" } });
    const before = await grantsOf("HR");
    const res = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(hrRole.id) },
      body: { permissions: [...before, "admin.settings", "staff.commission-pay"] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only an admin/i);
    expect(await grantsOf("HR")).toEqual(before);
  });

  it("refuses a General Manager creating a role", async () => {
    signInAs("gm");
    const res = await call(rolesIndexRoute, {
      method: "POST",
      body: { key: "SHADOW_ADMIN", name: "Shadow", permissions: ["admin.settings"] },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.role.findUnique({ where: { key: "SHADOW_ADMIN" } })).toBeNull();
  });

  it("still lets a staff manager READ the roles, for the Staff screen's picker", async () => {
    signInAs("hr");
    const res = await call(rolesIndexRoute, { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.roles)).toBe(true);
  });

  it("refuses an admin granting an owner-only key, naming it, and writes nothing", async () => {
    signInAs("admin");
    const lead = await prisma.role.create({
      data: { key: "FLOOR_LEAD", name: "Floor lead", isSystem: false, grantsAllPermissions: false },
    });
    const res = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(lead.id) },
      body: { permissions: ["sales.read", "staff.commission-pay"] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only an owner can grant or revoke/i);
    expect(await grantsOf("FLOOR_LEAD")).toEqual([]);
  });

  it("lets an admin edit other grants on a role that keeps an owner-granted key", async () => {
    const lead = await prisma.role.create({
      data: {
        key: "PAYROLL",
        name: "Payroll",
        isSystem: false,
        grantsAllPermissions: false,
        permissions: { create: [{ permission: "staff.commission-pay" }] },
      },
    });
    signInAs("admin");
    const res = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(lead.id) },
      body: { permissions: ["staff.commission-pay", "staff.read"] },
    });
    expect(res.statusCode).toBe(200);
    expect(await grantsOf("PAYROLL")).toEqual(["staff.commission-pay", "staff.read"]);
  });

  it("refuses an admin revoking or deleting an owner-granted key", async () => {
    const lead = await prisma.role.create({
      data: {
        key: "PAYROLL",
        name: "Payroll",
        isSystem: false,
        grantsAllPermissions: false,
        permissions: { create: [{ permission: "staff.commission-pay" }] },
      },
    });
    signInAs("admin");
    const revoke = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(lead.id) },
      body: { permissions: ["staff.read"] },
    });
    expect(revoke.statusCode).toBe(403);
    const del = await call(roleByIdRoute, { method: "DELETE", query: { id: String(lead.id) } });
    expect(del.statusCode).toBe(403);
    expect(await grantsOf("PAYROLL")).toEqual(["staff.commission-pay"]);
  });

  it("refuses an admin cloning the Owner, which would carry the owner-only keys", async () => {
    signInAs("admin");
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    const res = await call(rolesIndexRoute, {
      method: "POST",
      body: { key: "OWNER_COPY", name: "Owner copy", copyFromRoleId: ownerRole.id },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.role.findUnique({ where: { key: "OWNER_COPY" } })).toBeNull();
  });

  it("lets the Owner grant an owner-only key", async () => {
    const lead = await prisma.role.create({
      data: { key: "FLOOR_LEAD", name: "Floor lead", isSystem: false, grantsAllPermissions: false },
    });
    signInAs("owner");
    const res = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(lead.id) },
      body: { permissions: ["staff.commission-pay"] },
    });
    expect(res.statusCode).toBe(200);
    expect(await grantsOf("FLOOR_LEAD")).toEqual(["staff.commission-pay"]);
  });
});
