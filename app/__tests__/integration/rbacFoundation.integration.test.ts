// /app/__tests__/integration/rbacFoundation.integration.test.ts
//
// Real-DB coverage for the RBAC foundation: the built-in role seeder, the
// grant resolution behind requirePermission, and the guard itself end to end
// on the one route that uses it (POST /api/sales/orders/[id]/refunds).
//
// The pure decision rules are unit-tested exhaustively in
// __tests__/permissionDecision.test.ts and __tests__/permissionResolver.test.ts.
// What only a real database can show is here: that syncBuiltInRoles' diff is
// genuinely idempotent against Postgres, that the unique constraints hold, that
// grantsCustomized actually protects a deployment's edits across a reseed, and
// that a StaffMember row with roleId NULL resolves through the enum while one
// with a link resolves through the Role.
//
// NOTE: this file's schema comes from `prisma db push` (jest.integration.setup
// .ts), NOT from `prisma migrate deploy`. The migration's roleId backfill is
// therefore never executed by the suite -- __tests__/rolePermissionSchema.test
// .ts scans it instead.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { findOrphanPermissionKeys, syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import {
  invalidateRoleGrantCache,
  resolvePermissionAccess,
} from "@/lib/auth/permissionResolver";
import {
  BUILT_IN_ROLES,
  PERMISSION_KEYS,
  permissionsForBuiltInRole,
} from "@/lib/auth/permissionCatalog";
import refundsRoute from "@/pages/api/sales/orders/[id]/refunds";

const sessionMock = getServerSession as jest.Mock;

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    query: {},
    body: {},
    cookies: {},
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRes() {
  const res = {
    statusCode: 0,
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
  } as any as NextApiResponse & { statusCode: number; body: unknown };
  return res;
}

/** A staff member linked to the seeded Role of the given key. */
async function makeStaff(opts: {
  userId: string;
  roleKey: string;
  link?: boolean;
  isActive?: boolean;
}) {
  await prisma.user.create({ data: { id: opts.userId, email: `${opts.userId}@example.com` } });
  const role = await prisma.role.findUnique({ where: { key: opts.roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: opts.userId,
      displayName: opts.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: opts.roleKey as any,
      roleId: opts.link === false ? null : (role?.id ?? null),
      isActive: opts.isActive ?? true,
    },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
});

describe("syncBuiltInRoles", () => {
  it("creates all eight roles on an empty database", async () => {
    const result = await syncBuiltInRoles({ prisma });
    expect(result.rolesCreated).toBe(BUILT_IN_ROLES.length);
    expect(await prisma.role.count()).toBe(BUILT_IN_ROLES.length);
    expect(await prisma.role.count({ where: { isSystem: true } })).toBe(BUILT_IN_ROLES.length);
  });

  it("is idempotent — a second run writes nothing", async () => {
    await syncBuiltInRoles({ prisma });
    const grantsAfterFirst = await prisma.rolePermission.count();

    const second = await syncBuiltInRoles({ prisma });
    expect(second).toMatchObject({
      unchanged: true,
      rolesCreated: 0,
      rolesUpdated: 0,
      grantsAdded: 0,
      grantsRemoved: 0,
    });
    expect(await prisma.rolePermission.count()).toBe(grantsAfterFirst);
  });

  it("gives the Owner the wildcard flag and NOT 67 rows", async () => {
    await syncBuiltInRoles({ prisma });
    const owner = await prisma.role.findUniqueOrThrow({
      where: { key: "SUPER_ADMIN" },
      include: { permissions: true },
    });
    expect(owner.grantsAllPermissions).toBe(true);
    expect(owner.rank).toBe(3);
    expect(owner.permissions).toHaveLength(0);
  });

  it("materialises every non-wildcard role's grants exactly as the catalog declares", async () => {
    await syncBuiltInRoles({ prisma });
    for (const def of BUILT_IN_ROLES) {
      if (def.permissions === "*") continue;
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: def.key },
        include: { permissions: true },
      });
      expect({ key: def.key, grants: role.permissions.map((p) => p.permission).sort() }).toEqual({
        key: def.key,
        grants: permissionsForBuiltInRole(def.key).sort(),
      });
    }
  });

  it("reconciles a drifted built-in role that nobody customised", async () => {
    await syncBuiltInRoles({ prisma });
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });

    // Simulate a release that changed MANAGER's grants: strip one it should
    // hold, add one it should not.
    await prisma.rolePermission.deleteMany({
      where: { roleId: manager.id, permission: "payment.refund" },
    });
    await prisma.rolePermission.create({
      data: { roleId: manager.id, permission: "admin.settings" },
    });
    await prisma.role.update({ where: { id: manager.id }, data: { name: "Mangler", rank: 0 } });

    const result = await syncBuiltInRoles({ prisma });
    expect(result.unchanged).toBe(false);
    expect(result.grantsAdded).toBe(1);
    expect(result.grantsRemoved).toBe(1);

    const after = await prisma.role.findUniqueOrThrow({
      where: { key: "MANAGER" },
      include: { permissions: true },
    });
    expect(after.name).toBe("Manager");
    expect(after.rank).toBe(1);
    const keys = after.permissions.map((p) => p.permission);
    expect(keys).toContain("payment.refund");
    expect(keys).not.toContain("admin.settings");
  });

  it("does NOT clobber grants on a built-in role the deployment edited", async () => {
    await syncBuiltInRoles({ prisma });
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });

    // The deployment decides its managers may not refund, and says so.
    await prisma.rolePermission.deleteMany({
      where: { roleId: manager.id, permission: "payment.refund" },
    });
    await prisma.role.update({ where: { id: manager.id }, data: { grantsCustomized: true } });

    const result = await syncBuiltInRoles({ prisma });
    expect(result.grantsSkippedCustomized).toContain("MANAGER");

    const after = await prisma.role.findUniqueOrThrow({
      where: { key: "MANAGER" },
      include: { permissions: true },
    });
    expect(after.permissions.map((p) => p.permission)).not.toContain("payment.refund");
    // ...but identity is still reconciled from code.
    expect(after.name).toBe("Manager");
    expect(after.isSystem).toBe(true);
  });

  it("never touches a role the deployment invented", async () => {
    await syncBuiltInRoles({ prisma });
    const custom = await prisma.role.create({
      data: {
        key: "FLOOR_LEAD",
        name: "Floor Lead",
        rank: 1,
        isSystem: false,
        permissions: { create: [{ permission: "sales.discount" }] },
      },
      include: { permissions: true },
    });

    await syncBuiltInRoles({ prisma });

    const after = await prisma.role.findUniqueOrThrow({
      where: { key: "FLOOR_LEAD" },
      include: { permissions: true },
    });
    expect(after.isSystem).toBe(false);
    expect(after.name).toBe("Floor Lead");
    expect(after.permissions.map((p) => p.permission)).toEqual(["sales.discount"]);
    expect(after.id).toBe(custom.id);
  });

  it("dry run reports the full diff and writes nothing", async () => {
    const result = await syncBuiltInRoles({ prisma, dryRun: true });
    expect(result.rolesCreated).toBe(BUILT_IN_ROLES.length);
    // Grants too, not just roles — a dry run that under-reports is worse than
    // no dry run, because it reads as "this deploy changes less than it will".
    const expectedGrants = BUILT_IN_ROLES.filter((r) => r.permissions !== "*").reduce(
      (n, r) => n + permissionsForBuiltInRole(r.key).length,
      0,
    );
    expect(result.grantsAdded).toBe(expectedGrants);
    expect(await prisma.role.count()).toBe(0);
    expect(await prisma.rolePermission.count()).toBe(0);
  });
});

describe("findOrphanPermissionKeys", () => {
  it("catches a RolePermission row naming a key the catalog does not declare", async () => {
    await syncBuiltInRoles({ prisma });
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.rolePermission.create({
      data: { roleId: manager.id, permission: "payment.refnud" },
    });

    expect(await findOrphanPermissionKeys(prisma)).toEqual(["payment.refnud"]);
  });

  it("reports nothing for a freshly seeded database", async () => {
    await syncBuiltInRoles({ prisma });
    expect(await findOrphanPermissionKeys(prisma)).toEqual([]);
    // Sanity: every seeded key really is in the catalog.
    const rows = await prisma.rolePermission.findMany({ select: { permission: true } });
    for (const r of rows) expect(PERMISSION_KEYS).toContain(r.permission);
  });
});

describe("resolvePermissionAccess against a real database", () => {
  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
  });

  it("allows a linked MANAGER to refund and a linked DESIGNER not to", async () => {
    await makeStaff({ userId: "mgr", roleKey: "MANAGER" });
    await makeStaff({ userId: "dsgn", roleKey: "DESIGNER" });

    const mgr = await resolvePermissionAccess({
      userId: "mgr",
      permission: "payment.refund",
      impersonate: null,
    });
    expect({ allowed: mgr.allowed, fallback: mgr.viaEnumFallback }).toEqual({
      allowed: true,
      fallback: false,
    });

    const dsgn = await resolvePermissionAccess({
      userId: "dsgn",
      permission: "payment.refund",
      impersonate: null,
    });
    expect(dsgn.allowed).toBe(false);
  });

  it("falls back to the StaffRole enum for an unlinked staff member", async () => {
    await makeStaff({ userId: "unlinked", roleKey: "MANAGER", link: false });
    const r = await resolvePermissionAccess({
      userId: "unlinked",
      permission: "payment.refund",
      impersonate: null,
    });
    expect({ allowed: r.allowed, fallback: r.viaEnumFallback }).toEqual({
      allowed: true,
      fallback: true,
    });
  });

  it("revokes immediately when a staff member is deactivated", async () => {
    await makeStaff({ userId: "mgr", roleKey: "MANAGER" });
    await prisma.staffMember.updateMany({
      where: { userId: "mgr" },
      data: { isActive: false },
    });
    const r = await resolvePermissionAccess({
      userId: "mgr",
      permission: "payment.refund",
      impersonate: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.noActiveStaff).toBe(true);
  });

  it("does not let an ADMIN impersonate SUPER_ADMIN into an owner-only capability", async () => {
    await makeStaff({ userId: "adm", roleKey: "ADMIN" });
    const r = await resolvePermissionAccess({
      userId: "adm",
      permission: "admin.impersonate",
      impersonate: "SUPER_ADMIN",
    });
    expect(r.effectiveUserRole).toBe("ADMIN");
    expect(r.allowed).toBe(false);
  });

  it("gives the Owner a permission that has no RolePermission row anywhere", async () => {
    await makeStaff({ userId: "owner", roleKey: "SUPER_ADMIN" });
    const rows = await prisma.rolePermission.findMany({
      where: { permission: "reticulation.splines" },
    });
    expect(rows).toHaveLength(0);

    const r = await resolvePermissionAccess({
      userId: "owner",
      permission: "reticulation.splines",
      impersonate: null,
    });
    expect(r.allowed).toBe(true);
    expect(r.viaWildcard).toBe(true);
  });

  it("sees a revocation only after the cache is invalidated", async () => {
    await makeStaff({ userId: "mgr", roleKey: "MANAGER" });
    expect(
      (await resolvePermissionAccess({ userId: "mgr", permission: "payment.refund", impersonate: null }))
        .allowed,
    ).toBe(true);

    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: manager.id, permission: "payment.refund" },
    });

    // Still cached — this is the documented TTL window, not a bug.
    expect(
      (await resolvePermissionAccess({ userId: "mgr", permission: "payment.refund", impersonate: null }))
        .allowed,
    ).toBe(true);

    invalidateRoleGrantCache();
    expect(
      (await resolvePermissionAccess({ userId: "mgr", permission: "payment.refund", impersonate: null }))
        .allowed,
    ).toBe(false);
  });

  it("syncBuiltInRoles invalidates the cache itself when it writes", async () => {
    // Otherwise a deploy that restores a grant would keep 403ing for up to the
    // TTL afterwards, and the operator would conclude the seeder did nothing.
    await makeStaff({ userId: "dsgn", roleKey: "DESIGNER" });
    const designer = await prisma.role.findUniqueOrThrow({ where: { key: "DESIGNER" } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: designer.id, permission: "sales.read" },
    });
    invalidateRoleGrantCache();

    // Cache now warm and holding the revoked state.
    expect(
      (await resolvePermissionAccess({ userId: "dsgn", permission: "sales.read", impersonate: null }))
        .allowed,
    ).toBe(false);

    // The reseed restores it and must make that visible with no other help.
    const result = await syncBuiltInRoles({ prisma });
    expect(result.grantsAdded).toBe(1);
    expect(
      (await resolvePermissionAccess({ userId: "dsgn", permission: "sales.read", impersonate: null }))
        .allowed,
    ).toBe(true);
  });
});

describe("requirePermission on POST /api/sales/orders/[id]/refunds", () => {
  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
  });

  it("401s without a session", async () => {
    sessionMock.mockResolvedValue(null);
    const res = makeRes();
    await refundsRoute(makeReq({ query: { id: "1" } }), res);
    expect(res.statusCode).toBe(401);
  });

  it("403s a DESIGNER — the exact hole the audit found, now closed", async () => {
    await makeStaff({ userId: "dsgn", roleKey: "DESIGNER" });
    sessionMock.mockResolvedValue({ user: { id: "dsgn", email: "dsgn@example.com" } });

    const res = makeRes();
    await refundsRoute(makeReq({ query: { id: "1" } }), res);
    expect(res.statusCode).toBe(403);
  });

  it("403s a signed-in user who is not staff at all", async () => {
    // A privileged staff member must exist, or the bootstrap safeguard applies.
    await makeStaff({ userId: "adm", roleKey: "ADMIN" });
    await prisma.user.create({ data: { id: "portal", email: "portal@example.com" } });
    sessionMock.mockResolvedValue({ user: { id: "portal", email: "portal@example.com" } });

    const res = makeRes();
    await refundsRoute(makeReq({ query: { id: "1" } }), res);
    expect(res.statusCode).toBe(403);
  });

  it("lets a MANAGER past the guard and into the handler", async () => {
    await makeStaff({ userId: "mgr", roleKey: "MANAGER" });
    sessionMock.mockResolvedValue({ user: { id: "mgr", email: "mgr@example.com" } });

    // Past the guard, the handler's own validation rejects the empty body with
    // a 400 -- which is the proof: a 403 never happened.
    const res = makeRes();
    await refundsRoute(makeReq({ query: { id: "1" }, body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it("lets the Owner past through the wildcard", async () => {
    await makeStaff({ userId: "owner", roleKey: "SUPER_ADMIN" });
    sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });

    const res = makeRes();
    await refundsRoute(makeReq({ query: { id: "1" }, body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it("403s a MANAGER once the deployment revokes payment.refund", async () => {
    // The point of the whole exercise: policy moved without editing the route.
    await makeStaff({ userId: "mgr", roleKey: "MANAGER" });
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: manager.id, permission: "payment.refund" },
    });
    invalidateRoleGrantCache();
    sessionMock.mockResolvedValue({ user: { id: "mgr", email: "mgr@example.com" } });

    const res = makeRes();
    await refundsRoute(makeReq({ query: { id: "1" }, body: {} }), res);
    expect(res.statusCode).toBe(403);
  });

  it("honours an ADMIN impersonating DESIGNER — downward, so denied", async () => {
    await makeStaff({ userId: "adm", roleKey: "ADMIN" });
    sessionMock.mockResolvedValue({ user: { id: "adm", email: "adm@example.com" } });

    const res = makeRes();
    await refundsRoute(
      makeReq({ query: { id: "1" }, cookies: { "sh-impersonate": "DESIGNER" } }),
      res,
    );
    expect(res.statusCode).toBe(403);
  });
});
