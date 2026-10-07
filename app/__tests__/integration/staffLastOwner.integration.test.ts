// /app/__tests__/integration/staffLastOwner.integration.test.ts
//
// SEC-03, against a real database: an installation must never be left with no
// active admin. The guard used to live only in the role-change branch, so
// DELETE (soft-deactivate) and PATCH { isActive: false } could remove the last
// admin. This exercises the wired route through all three paths, both
// directions, plus the email-link hardening.
//
// Modeled on rbacFoundation.integration.test.ts: schema comes from
// `prisma db push` in jest.integration.setup.ts; getServerSession is mocked and
// the staff route runs for real against Postgres.

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
import { LAST_ADMIN_MESSAGE } from "@/lib/auth/adminLockout";
import staffRoute from "@/pages/api/staff/[id]";

const sessionMock = getServerSession as jest.Mock;

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: "GET", query: {}, body: {}, cookies: {}, ...over } as unknown as NextApiRequest;
}
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
    end(payload?: unknown) {
      body = payload;
      return res;
    },
    setHeader() {},
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

/** Seed a User + StaffMember linked to the seeded Role of the given key. */
async function makeStaff(opts: {
  userId: string;
  roleKey: string;
  isActive?: boolean;
  email?: string;
}): Promise<number> {
  await prisma.user.create({
    data: { id: opts.userId, email: opts.email ?? `${opts.userId}@example.com` },
  });
  const role = await prisma.role.findUnique({ where: { key: opts.roleKey } });
  const staff = await prisma.staffMember.create({
    data: {
      userId: opts.userId,
      displayName: opts.userId,
      email: opts.email ?? `${opts.userId}@example.com`,
      role: opts.roleKey as never,
      roleId: role?.id ?? null,
      isActive: opts.isActive ?? true,
    },
    select: { id: true },
  });
  return staff.id;
}

// The caller can manage staff but is NOT an admin, so a target ADMIN can be the
// sole admin. HR holds staff.manage (permissionCatalog.ts).
async function callAs(hrUserId: string, over: Partial<NextApiRequest>) {
  sessionMock.mockResolvedValue({ user: { id: hrUserId } });
  const res = makeRes();
  await staffRoute(makeReq(over), res);
  return res;
}

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  sessionMock.mockReset();
});

describe("SEC-03 last-admin guard (real DB)", () => {
  it("refuses DELETE of the only active admin with 409 and the pinned message", async () => {
    await makeStaff({ userId: "hr", roleKey: "HR" });
    const adminId = await makeStaff({ userId: "admin1", roleKey: "ADMIN" });

    const res = await callAs("hr", { method: "DELETE", query: { id: String(adminId) } });

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe(LAST_ADMIN_MESSAGE);
    // Nothing was written -- the admin is still active.
    const still = await prisma.staffMember.findUnique({ where: { id: adminId } });
    expect(still?.isActive).toBe(true);
  });

  it("allows DELETE of an admin while another active admin remains", async () => {
    await makeStaff({ userId: "hr", roleKey: "HR" });
    const admin1 = await makeStaff({ userId: "admin1", roleKey: "ADMIN" });
    await makeStaff({ userId: "admin2", roleKey: "ADMIN" });

    const res = await callAs("hr", { method: "DELETE", query: { id: String(admin1) } });

    expect(res.statusCode).toBe(0); // res.json without an explicit status
    const gone = await prisma.staffMember.findUnique({ where: { id: admin1 } });
    expect(gone?.isActive).toBe(false);
  });

  it("refuses PATCH { isActive: false } on the only active admin", async () => {
    await makeStaff({ userId: "hr", roleKey: "HR" });
    const adminId = await makeStaff({ userId: "admin1", roleKey: "ADMIN" });

    const res = await callAs("hr", {
      method: "PATCH",
      query: { id: String(adminId) },
      body: { isActive: false },
    });

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe(LAST_ADMIN_MESSAGE);
  });

  it("refuses demoting the only active admin to a non-admin role", async () => {
    await makeStaff({ userId: "hr", roleKey: "HR" });
    const adminId = await makeStaff({ userId: "admin1", roleKey: "ADMIN" });

    const res = await callAs("hr", {
      method: "PATCH",
      query: { id: String(adminId) },
      body: { role: "DESIGNER" },
    });

    // The role-change branch also forbids a non-admin caller changing roles, so
    // a 403 or 409 both mean "the demotion did not happen"; the lockout path is
    // the 409. Either way the admin keeps their role.
    expect([403, 409]).toContain(res.statusCode);
    const still = await prisma.staffMember.findUnique({ where: { id: adminId } });
    expect(still?.role).toBe("ADMIN");
  });

  it("refuses linking a staff record to a login already held by another active staff member", async () => {
    await makeStaff({ userId: "hr", roleKey: "HR" });
    await makeStaff({ userId: "admin1", roleKey: "ADMIN", email: "owner@store.com" });
    // A benign, unlinked staff record we try to point at the owner's login.
    const benign = await prisma.staffMember.create({
      data: {
        displayName: "benign",
        email: "benign@store.com",
        role: "DESIGNER" as never,
        isActive: true,
      },
      select: { id: true },
    });

    const res = await callAs("hr", {
      method: "PATCH",
      query: { id: String(benign.id) },
      body: { email: "owner@store.com" },
    });

    expect(res.statusCode).toBe(409);
    const after = await prisma.staffMember.findUnique({ where: { id: benign.id } });
    expect(after?.userId).toBeNull(); // never linked
  });
});
