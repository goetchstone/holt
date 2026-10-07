// /app/__tests__/integration/staffRoleAssignment.integration.test.ts
//
// USE-02: a staff member can be given any role -- built-in or one built on the
// Roles page -- and who may give it follows one rule (lib/auth/roleAssignment.ts):
// only an admin assigns roles, only an owner assigns the owner tier, and a
// custom role writes the least-privileged legacy enum. Real routes, real
// permission gate, real database; next-auth's session is the only mock.

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
import staffIndexRoute from "@/pages/api/staff/index";
import staffByIdRoute from "@/pages/api/staff/[id]";

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

function makeReq(over: Partial<NextApiRequest>): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "GET", query: {}, body: {}, cookies: {}, ...over } as any;
}

async function patchStaff(id: number, body: Record<string, unknown>): Promise<TestRes> {
  const res = makeRes();
  await staffByIdRoute(makeReq({ method: "PATCH", query: { id: String(id) }, body }), res);
  return res;
}

async function createStaff(body: Record<string, unknown>): Promise<TestRes> {
  const res = makeRes();
  await staffIndexRoute(makeReq({ method: "POST", body }), res);
  return res;
}

/** A signed-in staff member holding a built-in role (enum and roleId agree). */
async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: roleKey as any,
      roleId: role.id,
    },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

async function roleId(key: string): Promise<number> {
  return (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
}

async function customRole(key = "FLOOR_LEAD") {
  return prisma.role.create({
    data: {
      key,
      name: "Floor Lead",
      isSystem: false,
      permissions: { create: [{ permission: "sales.read" }, { permission: "sales.write" }] },
    },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("an admin assigns any role", () => {
  it("gives a custom role: roleId is set and the legacy enum is the least-privileged", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    await makeStaff("admin", "ADMIN");
    const target = await makeStaff("sam", "MANAGER");
    const floorLead = await customRole();
    signInAs("admin");

    const res = await patchStaff(target.id, { roleId: floorLead.id });

    expect(res.statusCode).toBe(200);
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.roleId).toBe(floorLead.id);
    expect(row.role).toBe("DESIGNER");
  });

  it("gives a built-in role: the enum is that role's own key", async () => {
    await makeStaff("admin", "ADMIN");
    const target = await makeStaff("sam", "DESIGNER");
    signInAs("admin");

    const res = await patchStaff(target.id, { roleId: await roleId("MANAGER") });

    expect(res.statusCode).toBe(200);
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.role).toBe("MANAGER");
    expect(row.roleId).toBe(await roleId("MANAGER"));
  });

  it("lets an owner (SUPER_ADMIN) assign roles -- the old check refused anyone but ADMIN", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    const target = await makeStaff("sam", "DESIGNER");
    signInAs("owner");

    const res = await patchStaff(target.id, { role: "MANAGER" });

    expect(res.statusCode).toBe(200);
    expect((await prisma.staffMember.findUniqueOrThrow({ where: { id: target.id } })).role).toBe(
      "MANAGER",
    );
  });

  it("refuses an unknown role", async () => {
    await makeStaff("admin", "ADMIN");
    const target = await makeStaff("sam", "DESIGNER");
    signInAs("admin");

    const res = await patchStaff(target.id, { roleId: 999_999 });

    expect(res.statusCode).toBe(400);
  });
});

describe("only an owner assigns the owner tier", () => {
  it("refuses an ADMIN making someone SUPER_ADMIN, and lets an owner", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    await makeStaff("admin", "ADMIN");
    const target = await makeStaff("sam", "MANAGER");

    signInAs("admin");
    const byAdmin = await patchStaff(target.id, { roleId: await roleId("SUPER_ADMIN") });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.body.error).toMatch(/owner/i);

    signInAs("owner");
    const byOwner = await patchStaff(target.id, { roleId: await roleId("SUPER_ADMIN") });
    expect(byOwner.statusCode).toBe(200);
  });
});

describe("a staff manager who is not an admin (HR)", () => {
  it("cannot change a role, but can still save a name with the role unchanged", async () => {
    await makeStaff("admin", "ADMIN");
    await makeStaff("hr", "HR");
    const target = await makeStaff("sam", "DESIGNER");
    signInAs("hr");

    const promote = await patchStaff(target.id, { roleId: await roleId("MANAGER") });
    expect(promote.statusCode).toBe(403);
    expect(promote.body.error).toMatch(/only an admin/i);

    const rename = await patchStaff(target.id, {
      displayName: "Samantha",
      roleId: await roleId("DESIGNER"),
    });
    expect(rename.statusCode).toBe(200);
    expect(
      (await prisma.staffMember.findUniqueOrThrow({ where: { id: target.id } })).displayName,
    ).toBe("Samantha");
  });

  it("cannot create an ADMIN -- which any staff.manage holder could before", async () => {
    await makeStaff("admin", "ADMIN");
    await makeStaff("hr", "HR");
    signInAs("hr");

    const res = await createStaff({ displayName: "New Admin", role: "ADMIN" });

    expect(res.statusCode).toBe(403);
    expect(await prisma.staffMember.count({ where: { displayName: "New Admin" } })).toBe(0);
  });

  it("can create a staff member, who gets the default role", async () => {
    await makeStaff("admin", "ADMIN");
    await makeStaff("hr", "HR");
    signInAs("hr");

    const res = await createStaff({ displayName: "New Designer" });

    expect(res.statusCode).toBe(201);
    const row = await prisma.staffMember.findFirstOrThrow({
      where: { displayName: "New Designer" },
    });
    expect(row.role).toBe("DESIGNER");
    expect(row.roleId).toBe(await roleId("DESIGNER"));
  });
});

describe("the last admin", () => {
  it("cannot be given a custom role, which writes the non-admin enum", async () => {
    const admin = await makeStaff("admin", "ADMIN");
    const floorLead = await customRole();
    signInAs("admin");

    const res = await patchStaff(admin.id, { roleId: floorLead.id });

    expect(res.statusCode).toBe(409);
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.role).toBe("ADMIN");
  });
});
