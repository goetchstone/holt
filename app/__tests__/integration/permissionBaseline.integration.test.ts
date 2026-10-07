// /app/__tests__/integration/permissionBaseline.integration.test.ts
//
// Real-DB half of the baseline floor. The unit file
// (__tests__/permissionBaseline.test.ts) pins the pure logic; what only Postgres
// can show is here:
//
//   - a freshly seeded database contains ZERO RolePermission rows naming a
//     baseline key, for any role, wildcard or not;
//   - a role the deployment invented through the admin GUI — which never offers
//     the baseline as a checkbox, so nothing in its write path could add it —
//     resolves staff.self anyway;
//   - a built-in role whose grants a deployment stripped to nothing still
//     resolves staff.self, and a reseed does not add a row for it either.
//
// The last one is the shape of the bug this whole design prevents: someone
// scopes a role down hard, and the next morning that role cannot clock in.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import {
  invalidateRoleGrantCache,
  getRoleGrantTable,
  resolvePermissionAccess,
} from "@/lib/auth/permissionResolver";
import { BASELINE_PERMISSIONS, isBaselinePermission } from "@/lib/auth/permissionCatalog";

/** A staff member linked to a Role by key. */
async function makeStaff(opts: {
  userId: string;
  roleKey: string;
  /** StaffRole enum value; defaults to roleKey when that is itself an enum value. */
  enumRole?: string;
  link?: boolean;
}) {
  await prisma.user.create({ data: { id: opts.userId, email: `${opts.userId}@example.com` } });
  const role = await prisma.role.findUnique({ where: { key: opts.roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: opts.userId,
      displayName: opts.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: (opts.enumRole ?? opts.roleKey) as any,
      roleId: opts.link === false ? null : (role?.id ?? null),
      isActive: true,
    },
  });
}

/**
 * Keep the bootstrap door SHUT. While no active, user-linked privileged staff
 * exist, every failing check passes — so a test asserting that the FLOOR grants
 * something would pass just as well with the floor deleted.
 */
async function makeBootstrapClosed() {
  await makeStaff({ userId: "owner-fixture", roleKey: "ADMIN" });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
});

describe("the seeder stores no baseline rows", () => {
  it("a freshly seeded database has no RolePermission row naming a baseline key", async () => {
    await syncBuiltInRoles({ prisma });

    const rows = await prisma.rolePermission.findMany({
      where: { permission: { in: [...BASELINE_PERMISSIONS] } },
      include: { role: { select: { key: true } } },
    });
    expect(rows.map((r) => ({ role: r.role.key, permission: r.permission }))).toEqual([]);

    // Belt and braces against a future baseline key the `in` clause above would
    // still match but a reader might not notice being added.
    const all = await prisma.rolePermission.findMany({ select: { permission: true } });
    expect(all.filter((r) => isBaselinePermission(r.permission))).toEqual([]);
    expect(all.length).toBeGreaterThan(0);
  });

  it("a reseed does not add one either — the diff is stable", async () => {
    await syncBuiltInRoles({ prisma });
    const second = await syncBuiltInRoles({ prisma });
    expect(second.unchanged).toBe(true);
    expect(second.grantsAdded).toBe(0);
  });

  it("a stray baseline row from a restored dump is reconciled away, not multiplied", async () => {
    // The row cannot come from this codebase, but it can come from a dump taken
    // before the floor existed. It is not in the desired set, so the ordinary
    // reconcile removes it — and the role keeps the capability regardless.
    await syncBuiltInRoles({ prisma });
    const designer = await prisma.role.findUniqueOrThrow({ where: { key: "DESIGNER" } });
    await prisma.rolePermission.create({
      data: { roleId: designer.id, permission: "staff.self" },
    });

    const result = await syncBuiltInRoles({ prisma });
    expect(result.grantsRemoved).toBe(1);
    const after = await prisma.rolePermission.findMany({ where: { roleId: designer.id } });
    expect(after.filter((r) => isBaselinePermission(r.permission))).toEqual([]);
  });
});

describe("the floor holds against a real grant table", () => {
  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
  });

  it("every seeded role resolves the baseline even with no row backing it", async () => {
    const table = await getRoleGrantTable(prisma);
    const missing = Object.entries(table.grantsByRole)
      .filter(([, grants]) => BASELINE_PERMISSIONS.some((b) => !grants.includes(b)))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it("a role the deployment invented holds it without anyone granting it", async () => {
    await makeBootstrapClosed();
    const custom = await prisma.role.create({
      data: {
        key: "FLOOR_LEAD",
        name: "Floor Lead",
        rank: 1,
        isSystem: false,
        permissions: { create: [{ permission: "sales.discount" }] },
      },
    });
    await prisma.user.create({ data: { id: "lead", email: "lead@example.com" } });
    await prisma.staffMember.create({
      data: {
        userId: "lead",
        displayName: "lead",
        role: "DESIGNER",
        roleId: custom.id,
        isActive: true,
      },
    });
    invalidateRoleGrantCache();

    const self = await resolvePermissionAccess({
      userId: "lead",
      permission: "staff.self",
      impersonate: null,
    });
    expect({ allowed: self.allowed, bootstrap: self.bootstrapBypass }).toEqual({
      allowed: true,
      bootstrap: false,
    });

    // ...and nothing came with it. staff.time is the neighbour most likely to be
    // dragged in by a sloppy implementation of the floor.
    const time = await resolvePermissionAccess({
      userId: "lead",
      permission: "staff.time",
      impersonate: null,
    });
    expect(time.allowed).toBe(false);
  });

  it("a built-in role stripped to zero grants can still clock in", async () => {
    await makeBootstrapClosed();
    await makeStaff({ userId: "dsgn", roleKey: "DESIGNER" });
    const designer = await prisma.role.findUniqueOrThrow({ where: { key: "DESIGNER" } });
    await prisma.rolePermission.deleteMany({ where: { roleId: designer.id } });
    await prisma.role.update({
      where: { id: designer.id },
      data: { grantsCustomized: true },
    });
    invalidateRoleGrantCache();

    const sales = await resolvePermissionAccess({
      userId: "dsgn",
      permission: "sales.read",
      impersonate: null,
    });
    expect(sales.allowed).toBe(false);

    const self = await resolvePermissionAccess({
      userId: "dsgn",
      permission: "staff.self",
      impersonate: null,
    });
    expect({ allowed: self.allowed, bootstrap: self.bootstrapBypass }).toEqual({
      allowed: true,
      bootstrap: false,
    });
  });

  it("does not extend the floor to someone with no active staff row", async () => {
    await makeBootstrapClosed();
    await prisma.user.create({ data: { id: "portal", email: "portal@example.com" } });

    const r = await resolvePermissionAccess({
      userId: "portal",
      permission: "staff.self",
      impersonate: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.noActiveStaff).toBe(true);
  });

  it("does not extend it to someone deactivated this morning", async () => {
    await makeBootstrapClosed();
    await makeStaff({ userId: "gone", roleKey: "REGISTER" });
    await prisma.staffMember.updateMany({ where: { userId: "gone" }, data: { isActive: false } });
    invalidateRoleGrantCache();

    const r = await resolvePermissionAccess({
      userId: "gone",
      permission: "staff.self",
      impersonate: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.noActiveStaff).toBe(true);
  });
});
