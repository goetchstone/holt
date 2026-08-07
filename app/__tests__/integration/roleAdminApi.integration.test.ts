// /app/__tests__/integration/roleAdminApi.integration.test.ts
//
// Real-DB coverage for the custom-role admin API (src/pages/api/admin/roles/*).
//
// The pure rules — key format, unknown-key rejection, the lockout COUNT — are
// unit-tested exhaustively in __tests__/roleAdmin.test.ts. What only a real
// database can show is here, and it is the half that matters:
//
//   - the lockout guards actually REFUSE, inside the transaction, with nothing
//     written. A guard that computes the right answer and then writes anyway is
//     the failure mode this whole feature exists to prevent;
//   - a built-in edit sets grantsCustomized, so tonight's deploy does not
//     silently undo it (see Role.grantsCustomized in schema.prisma);
//   - the grant cache is dropped on every write path, so a revocation bites
//     immediately rather than up to ROLE_GRANT_CACHE_TTL_MS later;
//   - cloning is the primary creation path and copies what the source ACTUALLY
//     grants, including the wildcard's expansion.
//
// NOTE: this file's schema comes from `prisma db push` (jest.integration.setup
// .ts), not from `prisma migrate deploy` — same caveat as rbacFoundation.

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
import * as permissionResolver from "@/lib/auth/permissionResolver";
import {
  getRoleGrantTable,
  invalidateRoleGrantCache,
  resolvePermissionAccess,
} from "@/lib/auth/permissionResolver";
import { BASELINE_PERMISSIONS, PERMISSION_KEYS } from "@/lib/auth/permissionCatalog";
import { LOCKOUT_PERMISSION, type RoleSummary } from "@/lib/auth/roleAdmin";
import rolesIndexRoute from "@/pages/api/admin/roles/index";
import roleByIdRoute from "@/pages/api/admin/roles/[id]";

const sessionMock = getServerSession as jest.Mock;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
    end(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TestRes;
  return res;
}

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "GET", query: {}, body: {}, cookies: {}, ...over } as any;
}

async function callIndex(over: Partial<NextApiRequest>): Promise<TestRes> {
  const res = makeRes();
  await rolesIndexRoute(makeReq(over), res);
  return res;
}

async function callById(id: number, over: Partial<NextApiRequest>): Promise<TestRes> {
  const res = makeRes();
  await roleByIdRoute(makeReq({ ...over, query: { id: String(id), ...(over.query ?? {}) } }), res);
  return res;
}

/** A signed-in staff member. `roleKey` links StaffMember.roleId to that Role. */
async function makeStaff(opts: {
  userId: string;
  /** The StaffRole enum value stored on the row. */
  enumRole: string;
  /** Role.key to link roleId to; omit for an unlinked (enum-fallback) member. */
  roleKey?: string;
  isActive?: boolean;
  /** An up-board name with no login. Never counts toward the lockout guard. */
  unlinkedUser?: boolean;
}) {
  if (!opts.unlinkedUser) {
    await prisma.user.create({
      data: { id: opts.userId, email: `${opts.userId}@example.com` },
    });
  }
  const role = opts.roleKey
    ? await prisma.role.findUniqueOrThrow({ where: { key: opts.roleKey } })
    : null;
  return prisma.staffMember.create({
    data: {
      userId: opts.unlinkedUser ? null : opts.userId,
      displayName: opts.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: opts.enumRole as any,
      roleId: role?.id ?? null,
      isActive: opts.isActive ?? true,
    },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

/** A deployment role with an explicit grant list. */
async function makeRole(key: string, permissions: string[], over: Record<string, unknown> = {}) {
  return prisma.role.create({
    data: {
      key,
      name: key,
      isSystem: false,
      grantsAllPermissions: false,
      ...over,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
    include: { permissions: true },
  });
}

/** The RoleSummary for `key` out of a GET /api/admin/roles response. */
function roleNamed(res: TestRes, key: string): RoleSummary {
  const found = (res.body.roles as RoleSummary[]).find((r) => r.key === key);
  if (!found) throw new Error(`no role ${key} in the response`);
  return found;
}

async function grantsOf(roleId: number): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permission: true },
  });
  return rows.map((r) => r.permission).sort();
}

/**
 * The actor for tests that are not ABOUT the lockout: an ADMIN, linked to the
 * seeded ADMIN role, so they hold staff.manage through the role table and keep
 * the bootstrap safeguard shut (it grants every failing check while no active,
 * user-linked SUPER_ADMIN/ADMIN/MANAGER exists, which would make any assertion
 * about a refusal meaningless).
 */
async function signInAsAdmin(userId = "admin-fixture") {
  await makeStaff({ userId, enumRole: "ADMIN", roleKey: "ADMIN" });
  signInAs(userId);
  invalidateRoleGrantCache();
  return userId;
}

let invalidateSpy: jest.SpyInstance;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  // Passes through to the real implementation; we only count the calls.
  invalidateSpy = jest.spyOn(permissionResolver, "invalidateRoleGrantCache");
});

afterEach(() => {
  invalidateSpy.mockRestore();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// GET /api/admin/roles
// ---------------------------------------------------------------------------

describe("GET /api/admin/roles", () => {
  it("returns the roles, the catalog and the baseline", async () => {
    await signInAsAdmin();
    const res = await callIndex({ method: "GET" });

    expect(res.statusCode).toBe(200);
    expect(res.body.roles).toHaveLength(8);
    expect(res.body.catalog.permissions.length).toBe(PERMISSION_KEYS.length);
    expect(res.body.catalog.domains.length).toBeGreaterThan(0);
    expect(res.body.baseline).toEqual([...BASELINE_PERMISSIONS]);
  });

  it("orders most-privileged first and reports staff and permission counts", async () => {
    await signInAsAdmin();
    const res = await callIndex({ method: "GET" });

    expect(res.body.roles[0].key).toBe("SUPER_ADMIN");

    const owner = roleNamed(res, "SUPER_ADMIN");
    expect(owner.grantsAllPermissions).toBe(true);
    // Zero RolePermission rows, but it grants the whole catalog. Reporting 0
    // here would read in the admin list as "grants nothing".
    expect(owner.permissionCount).toBe(PERMISSION_KEYS.length - BASELINE_PERMISSIONS.length);

    expect(roleNamed(res, "ADMIN").staffCount).toBe(1); // the fixture actor
  });

  it("never reports the baseline as one of a role's grants", async () => {
    await signInAsAdmin();
    const res = await callIndex({ method: "GET" });
    const detail = await callById(roleNamed(res, "MANAGER").id, {
      method: "GET",
    });
    for (const baseline of BASELINE_PERMISSIONS) {
      expect(detail.body.role.permissions).not.toContain(baseline);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/roles
// ---------------------------------------------------------------------------

describe("POST /api/admin/roles", () => {
  it("creates a role by CLONING an existing one — the primary creation path", async () => {
    await signInAsAdmin();
    const designer = await prisma.role.findUniqueOrThrow({
      where: { key: "DESIGNER" },
      include: { permissions: true },
    });

    const res = await callIndex({
      method: "POST",
      body: { key: "FLOOR_LEAD", name: "Floor Lead", copyFromRoleId: designer.id },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.role.key).toBe("FLOOR_LEAD");
    expect(res.body.role.isSystem).toBe(false);
    expect(res.body.role.grantsAllPermissions).toBe(false);
    expect(res.body.role.permissions).toEqual(designer.permissions.map((p) => p.permission).sort());
    expect(await grantsOf(res.body.role.id)).toEqual(res.body.role.permissions);
  });

  it("clone-then-adjust: an explicit permissions list wins over the source", async () => {
    await signInAsAdmin();
    const designer = await prisma.role.findUniqueOrThrow({ where: { key: "DESIGNER" } });

    const res = await callIndex({
      method: "POST",
      body: {
        key: "FLOOR_LEAD",
        name: "Floor Lead",
        copyFromRoleId: designer.id,
        permissions: ["sales.read", "sales.discount"],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.role.permissions).toEqual(["sales.discount", "sales.read"]);
  });

  it("cloning the wildcard Owner materialises the catalog, not its zero rows", async () => {
    await signInAsAdmin();
    const owner = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    expect(await grantsOf(owner.id)).toEqual([]);

    const res = await callIndex({
      method: "POST",
      body: { key: "DEPUTY", name: "Deputy", copyFromRoleId: owner.id },
    });

    expect(res.statusCode).toBe(201);
    // A new role cannot itself hold the wildcard, so copying zero rows would
    // have produced a "copy of the Owner" that grants nothing.
    expect(res.body.role.grantsAllPermissions).toBe(false);
    expect(res.body.role.permissions).toHaveLength(
      PERMISSION_KEYS.length - BASELINE_PERMISSIONS.length,
    );
    expect(res.body.role.permissions).toContain("payment.refund");
  });

  it("refuses an unknown permission key BY NAME and writes nothing", async () => {
    await signInAsAdmin();
    const before = await prisma.role.count();

    const res = await callIndex({
      method: "POST",
      body: {
        key: "FLOOR_LEAD",
        name: "Floor Lead",
        permissions: ["sales.read", "sales.teleport"],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("sales.teleport");
    expect(await prisma.role.count()).toBe(before);
    expect(await prisma.role.findUnique({ where: { key: "FLOOR_LEAD" } })).toBeNull();
  });

  it.each(BASELINE_PERMISSIONS)("silently ignores the baseline key %s", async (baseline) => {
    await signInAsAdmin();
    const res = await callIndex({
      method: "POST",
      body: { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read", baseline] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.role.permissions).toEqual(["sales.read"]);
    // Never a row: a stored baseline reads in the GUI as a grant someone made,
    // which invites someone to un-make it.
    expect(await grantsOf(res.body.role.id)).toEqual(["sales.read"]);
  });

  it("refuses a key that collides with a StaffRole enum value", async () => {
    await signInAsAdmin();
    const res = await callIndex({
      method: "POST",
      body: { key: "MANAGER", name: "My Manager", permissions: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reserved for the built-in role/);
  });

  it("refuses a malformed key and says what a valid one looks like", async () => {
    await signInAsAdmin();
    const res = await callIndex({
      method: "POST",
      body: { key: "floor lead", name: "Floor Lead", permissions: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uppercase A-Z, digits and underscore/);
  });

  it("refuses a duplicate key with 409", async () => {
    await signInAsAdmin();
    await makeRole("FLOOR_LEAD", ["sales.read"]);

    const res = await callIndex({
      method: "POST",
      body: { key: "FLOOR_LEAD", name: "Floor Lead", permissions: [] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("FLOOR_LEAD");
  });

  it("refuses a copyFromRoleId that names no role", async () => {
    await signInAsAdmin();
    const res = await callIndex({
      method: "POST",
      body: { key: "FLOOR_LEAD", name: "Floor Lead", copyFromRoleId: 99999 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("99999");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/roles/[id]
// ---------------------------------------------------------------------------

describe("PUT /api/admin/roles/[id]", () => {
  it("edits a role's name, description, rank and grants", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);

    const res = await callById(role.id, {
      method: "PUT",
      body: {
        name: "Floor Captain",
        description: "Runs the floor",
        rank: 1,
        permissions: ["sales.read", "sales.write"],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.role).toMatchObject({
      name: "Floor Captain",
      description: "Runs the floor",
      rank: 1,
      permissions: ["sales.read", "sales.write"],
    });
    expect(await grantsOf(role.id)).toEqual(["sales.read", "sales.write"]);
  });

  it("editing a BUILT-IN role's permissions sets grantsCustomized", async () => {
    await signInAsAdmin();
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    expect(manager.grantsCustomized).toBe(false);

    const res = await callById(manager.id, {
      method: "PUT",
      body: { permissions: ["sales.read", "sales.write"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.role.grantsCustomized).toBe(true);

    // ...and the flag is what actually stops the deploy-time seeder putting the
    // shipped grants back tonight.
    const reseed = await syncBuiltInRoles({ prisma });
    expect(reseed.grantsSkippedCustomized).toContain("MANAGER");
    expect(await grantsOf(manager.id)).toEqual(["sales.read", "sales.write"]);
  });

  it("a no-op save of a built-in role does NOT flip grantsCustomized", async () => {
    await signInAsAdmin();
    const manager = await prisma.role.findUniqueOrThrow({
      where: { key: "MANAGER" },
      include: { permissions: true },
    });

    const res = await callById(manager.id, {
      method: "PUT",
      body: { permissions: manager.permissions.map((p) => p.permission) },
    });

    expect(res.statusCode).toBe(200);
    // Opting out of future releases' permission additions is a consequence of
    // an EDIT, not of pressing Save.
    expect(res.body.role.grantsCustomized).toBe(false);
  });

  it("renaming a deployment's own role leaves grantsCustomized alone", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
    const res = await callById(role.id, { method: "PUT", body: { name: "Renamed" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.role.grantsCustomized).toBe(false);
  });

  it("refuses an unknown permission key by name and writes nothing", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);

    const res = await callById(role.id, {
      method: "PUT",
      body: { name: "Changed", permissions: ["sales.teleport"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("sales.teleport");
    expect(await grantsOf(role.id)).toEqual(["sales.read"]);
    expect((await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).name).toBe(
      "FLOOR_LEAD",
    );
  });

  it.each(["key", "isSystem", "grantsAllPermissions"])(
    "refuses an attempt to change %s",
    async (field) => {
      await signInAsAdmin();
      const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
      const value = field === "key" ? "SOMETHING_ELSE" : true;

      const res = await callById(role.id, { method: "PUT", body: { [field]: value } });

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain(field);
      const after = await prisma.role.findUniqueOrThrow({ where: { id: role.id } });
      expect(after.key).toBe("FLOOR_LEAD");
      expect(after.isSystem).toBe(false);
      expect(after.grantsAllPermissions).toBe(false);
    },
  );

  it("accepts an echoed-back immutable field that does not change anything", async () => {
    // The editor round-trips a RoleDetail; refusing the unchanged value would
    // make the obvious client implementation wrong.
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);

    const res = await callById(role.id, {
      method: "PUT",
      body: { key: "FLOOR_LEAD", isSystem: false, grantsAllPermissions: false, name: "Kept" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.role.name).toBe("Kept");
  });

  it("refuses to edit a wildcard role's permission list", async () => {
    await signInAsAdmin();
    const owner = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });

    const res = await callById(owner.id, {
      method: "PUT",
      body: { permissions: ["sales.read"] },
    });

    // Rows would be written and never read — the check short-circuits on the
    // flag — so the operator would watch a checkbox clear and the capability
    // survive.
    expect(res.statusCode).toBe(409);
    expect(await grantsOf(owner.id)).toEqual([]);
  });

  it("404s for a role that does not exist", async () => {
    await signInAsAdmin();
    const res = await callById(99999, { method: "PUT", body: { name: "x" } });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The self-lockout guard
// ---------------------------------------------------------------------------

describe("self-lockout guard", () => {
  /**
   * A deployment whose ONLY route to staff.manage is one custom role, held by
   * one active signed-in person — the actor. Their StaffRole enum is MANAGER so
   * the bootstrap safeguard stays shut (it counts the enum, not the link), but
   * MANAGER does not hold staff.manage, so removing the custom role's grant
   * really does take the last one away.
   */
  async function soleAdminDeployment() {
    const soleRole = await makeRole("SOLE_ADMIN", [LOCKOUT_PERMISSION, "sales.read"]);
    await makeStaff({ userId: "sole", enumRole: "MANAGER", roleKey: "SOLE_ADMIN" });
    signInAs("sole");
    invalidateRoleGrantCache();
    return soleRole;
  }

  it("PUT refuses to revoke the last staff.manage, with 409 and nothing written", async () => {
    const soleRole = await soleAdminDeployment();

    const res = await callById(soleRole.id, {
      method: "PUT",
      body: { name: "Renamed too", permissions: ["sales.read"] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain(LOCKOUT_PERMISSION);
    expect(res.body.error).toMatch(/grant it back/);
    // The whole transaction unwound: the rename did not survive either.
    expect(await grantsOf(soleRole.id)).toEqual([LOCKOUT_PERMISSION, "sales.read"].sort());
    expect((await prisma.role.findUniqueOrThrow({ where: { id: soleRole.id } })).name).toBe(
      "SOLE_ADMIN",
    );
  });

  it("PUT allows the same revocation once somebody else holds it", async () => {
    const soleRole = await soleAdminDeployment();
    await makeStaff({ userId: "other-admin", enumRole: "MANAGER", roleKey: "ADMIN" });
    invalidateRoleGrantCache();

    const res = await callById(soleRole.id, {
      method: "PUT",
      body: { permissions: ["sales.read"] },
    });

    expect(res.statusCode).toBe(200);
    expect(await grantsOf(soleRole.id)).toEqual(["sales.read"]);
  });

  it("DELETE refuses when reassignment would move the last holders somewhere powerless", async () => {
    const soleRole = await soleAdminDeployment();
    const shipper = await makeRole("SHIPPER", ["sales.read"]);

    const res = await callById(soleRole.id, {
      method: "DELETE",
      query: { reassignToRoleId: String(shipper.id) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain(LOCKOUT_PERMISSION);
    expect(await prisma.role.findUnique({ where: { id: soleRole.id } })).not.toBeNull();
    const staff = await prisma.staffMember.findFirstOrThrow({ where: { displayName: "sole" } });
    expect(staff.roleId).toBe(soleRole.id);
  });

  it("an INACTIVE holder does not keep the guard open", async () => {
    // isActive is part of the authorization decision everywhere else; a guard
    // that counted deactivated people would pass while the deployment is in
    // fact locked out.
    const soleRole = await soleAdminDeployment();
    await makeStaff({
      userId: "retired-admin",
      enumRole: "MANAGER",
      roleKey: "ADMIN",
      isActive: false,
    });
    invalidateRoleGrantCache();

    const res = await callById(soleRole.id, {
      method: "PUT",
      body: { permissions: ["sales.read"] },
    });

    expect(res.statusCode).toBe(409);
  });

  it("a staff row with no login does not keep the guard open", async () => {
    // An up-board name nobody can sign in as cannot administer anything.
    const soleRole = await soleAdminDeployment();
    await makeStaff({
      userId: "board-only",
      enumRole: "MANAGER",
      roleKey: "ADMIN",
      unlinkedUser: true,
    });
    invalidateRoleGrantCache();

    const res = await callById(soleRole.id, {
      method: "PUT",
      body: { permissions: ["sales.read"] },
    });

    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/roles/[id]
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/roles/[id]", () => {
  it("refuses to delete a built-in role, always", async () => {
    await signInAsAdmin();
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });

    const res = await callById(manager.id, { method: "DELETE" });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/built-in role/);
    expect(await prisma.role.findUnique({ where: { id: manager.id } })).not.toBeNull();
  });

  it("refuses a built-in even when nobody holds it and a reassign target is given", async () => {
    await signInAsAdmin();
    const installer = await prisma.role.findUniqueOrThrow({ where: { key: "INSTALLER" } });
    const shipper = await makeRole("SHIPPER", ["sales.read"]);

    const res = await callById(installer.id, {
      method: "DELETE",
      query: { reassignToRoleId: String(shipper.id) },
    });

    expect(res.statusCode).toBe(409);
    expect(await prisma.role.findUnique({ where: { id: installer.id } })).not.toBeNull();
  });

  it("deletes an unused deployment role and cascades its grants", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read", "sales.write"]);

    const res = await callById(role.id, { method: "DELETE" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, reassigned: 0 });
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
    expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
  });

  it("refuses a role with staff on it when no destination is named", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
    await makeStaff({ userId: "lead-a", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });

    const res = await callById(role.id, { method: "DELETE" });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("1 staff member");
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
  });

  it("reassigns the staff inside the same transaction and reports how many moved", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
    const shipper = await makeRole("SHIPPER", ["sales.read"]);
    await makeStaff({ userId: "lead-a", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });
    await makeStaff({ userId: "lead-b", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });
    // Inactive staff still block the delete and still move: reactivating one
    // whose role vanished would silently drop them to the StaffRole enum.
    await makeStaff({
      userId: "lead-c",
      enumRole: "DESIGNER",
      roleKey: "FLOOR_LEAD",
      isActive: false,
    });

    const res = await callById(role.id, {
      method: "DELETE",
      query: { reassignToRoleId: String(shipper.id) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, reassigned: 3 });
    expect(await prisma.staffMember.count({ where: { roleId: shipper.id } })).toBe(3);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it("refuses a destination that is the role being deleted", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
    await makeStaff({ userId: "lead-a", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });

    const res = await callById(role.id, {
      method: "DELETE",
      query: { reassignToRoleId: String(role.id) },
    });

    expect(res.statusCode).toBe(409);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
  });

  it("refuses a destination that does not exist", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
    await makeStaff({ userId: "lead-a", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });

    const res = await callById(role.id, {
      method: "DELETE",
      query: { reassignToRoleId: "99999" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("99999");
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
  });

  it("404s for a role that does not exist", async () => {
    await signInAsAdmin();
    const res = await callById(99999, { method: "DELETE" });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation — every write path
// ---------------------------------------------------------------------------

describe("the grant cache is dropped on every write path", () => {
  it("POST invalidates, and a staff member on the new role resolves immediately", async () => {
    await signInAsAdmin();
    // Warm the cache so a stale table would be the one answering below.
    await getRoleGrantTable(prisma);
    invalidateSpy.mockClear();

    const created = await callIndex({
      method: "POST",
      body: { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["staff.read"] },
    });
    expect(created.statusCode).toBe(201);
    expect(invalidateSpy).toHaveBeenCalled();

    await makeStaff({ userId: "lead-a", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });
    // A stale table has no keyById entry for the new role, so this would fall
    // back to the DESIGNER enum, which does not hold staff.read.
    const access = await resolvePermissionAccess({
      userId: "lead-a",
      permission: "staff.read",
      impersonate: null,
      prisma,
    });
    expect(access.allowed).toBe(true);
    expect(access.viaEnumFallback).toBe(false);
  });

  it("PUT invalidates, and the revocation bites on the very next request", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.discount"]);
    await makeStaff({ userId: "lead-a", enumRole: "DESIGNER", roleKey: "FLOOR_LEAD" });
    invalidateRoleGrantCache();

    const before = await resolvePermissionAccess({
      userId: "lead-a",
      permission: "sales.discount",
      impersonate: null,
      prisma,
    });
    expect(before.allowed).toBe(true);

    invalidateSpy.mockClear();
    const res = await callById(role.id, { method: "PUT", body: { permissions: [] } });
    expect(res.statusCode).toBe(200);
    expect(invalidateSpy).toHaveBeenCalled();

    // No sleep, no TTL: a revocation that takes 30s to bite is a security bug.
    const after = await resolvePermissionAccess({
      userId: "lead-a",
      permission: "sales.discount",
      impersonate: null,
      prisma,
    });
    expect(after.allowed).toBe(false);
  });

  it("DELETE invalidates, and the deleted role is gone from the next grant table", async () => {
    await signInAsAdmin();
    const role = await makeRole("FLOOR_LEAD", ["sales.read"]);
    const warm = await getRoleGrantTable(prisma);
    expect(warm.keyById[role.id]).toBe("FLOOR_LEAD");

    invalidateSpy.mockClear();
    const res = await callById(role.id, { method: "DELETE" });
    expect(res.statusCode).toBe(200);
    expect(invalidateSpy).toHaveBeenCalled();

    const after = await getRoleGrantTable(prisma);
    expect(after.keyById[role.id]).toBeUndefined();
  });

  it("a REFUSED write does not invalidate — nothing changed", async () => {
    await signInAsAdmin();
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    invalidateSpy.mockClear();

    const res = await callById(manager.id, { method: "DELETE" });

    expect(res.statusCode).toBe(409);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Method and id handling
// ---------------------------------------------------------------------------

describe("method and id handling", () => {
  it("405s an unsupported method on both routes", async () => {
    await signInAsAdmin();
    expect((await callIndex({ method: "PATCH" })).statusCode).toBe(405);
    expect((await callById(1, { method: "PATCH" })).statusCode).toBe(405);
  });

  it("400s a non-numeric role id", async () => {
    await signInAsAdmin();
    const res = makeRes();
    await roleByIdRoute(makeReq({ method: "GET", query: { id: "not-a-number" } }), res);
    expect(res.statusCode).toBe(400);
  });

  it("403s a caller without staff.manage", async () => {
    // The bootstrap safeguard must be shut for this to mean anything.
    await signInAsAdmin();
    await makeStaff({ userId: "designer", enumRole: "DESIGNER", roleKey: "DESIGNER" });
    signInAs("designer");
    invalidateRoleGrantCache();

    expect((await callIndex({ method: "GET" })).statusCode).toBe(403);
    expect(
      (await callIndex({ method: "POST", body: { key: "X_Y", name: "x", permissions: [] } }))
        .statusCode,
    ).toBe(403);
  });
});
