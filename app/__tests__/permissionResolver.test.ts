// /app/__tests__/permissionResolver.test.ts
//
// PLACEHOLDER TEST — Grade: A (mocked-Prisma wiring only, not SQL behavior)
//
// buildRoleGrantTable is pure and takes literal Role-shaped rows, so most of
// this file exercises no SQL. The Prisma mock is an isolation shim; where it
// stands in for a round trip (the cache, the enum fallback) it returns canned
// rows and verifies none of Prisma's own query behaviour -- the real-DB
// assertions live in __tests__/integration/rbacFoundation.integration.test.ts.
//
// What IS genuinely under test here is in-process logic: the rank floor that
// stops a database row lowering SUPER_ADMIN's privilege, the TTL/generation
// cache (a stale grant table after a revocation is a security bug, so
// invalidation has to actually invalidate), and the StaffRole fallback that
// makes the route sweep adoptable one route at a time.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    role: { findMany: jest.fn() },
    staffMember: { findFirst: jest.fn(), count: jest.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { BASELINE_PERMISSIONS, permissionsForBuiltInRole } from "@/lib/auth/permissionCatalog";
import {
  buildRoleGrantTable,
  getRoleGrantTable,
  invalidateRoleGrantCache,
  resolvePermissionAccess,
  resolveRoleListAccess,
  ROLE_GRANT_CACHE_TTL_MS,
  type RoleGrantRow,
} from "@/lib/auth/permissionResolver";

const roleFindMany = prisma.role.findMany as jest.Mock;
const staffFindFirst = prisma.staffMember.findFirst as jest.Mock;
const staffCount = prisma.staffMember.count as jest.Mock;

function row(over: Partial<RoleGrantRow> & Pick<RoleGrantRow, "id" | "key">): RoleGrantRow {
  return {
    rank: 0,
    grantsAllPermissions: false,
    permissions: [],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateRoleGrantCache();
  staffCount.mockResolvedValue(5);
});

describe("buildRoleGrantTable", () => {
  it("maps grants by role key and resolves ids to keys", () => {
    const t = buildRoleGrantTable([
      row({ id: 7, key: "MANAGER", rank: 1, permissions: [{ permission: "payment.refund" }] }),
    ]);
    // Stored rows first, then the implicit floor — see BASELINE_PERMISSIONS.
    expect(t.grantsByRole.MANAGER).toEqual(["payment.refund", ...BASELINE_PERMISSIONS]);
    expect(t.keyById[7]).toBe("MANAGER");
    expect(t.empty).toBe(false);
  });

  it("reports an unseeded database as empty", () => {
    expect(buildRoleGrantTable([]).empty).toBe(true);
  });

  it("collects wildcard roles from grantsAllPermissions", () => {
    const t = buildRoleGrantTable([row({ id: 1, key: "OWNER_CLONE", grantsAllPermissions: true })]);
    expect(t.wildcardRoles).toContain("OWNER_CLONE");
    // ...and the shipped wildcard is always present, seeded or not.
    expect(t.wildcardRoles).toContain("SUPER_ADMIN");
  });

  it("lets a database row RAISE a custom role's rank", () => {
    const t = buildRoleGrantTable([row({ id: 1, key: "FLOOR_LEAD", rank: 4 })]);
    expect(t.ranks.FLOOR_LEAD).toBe(4);
  });

  it("refuses to let a database row LOWER a built-in role's rank", () => {
    // An escalation hole otherwise: set SUPER_ADMIN's rank to 0 in the database
    // and an ADMIN could impersonate up into it. Ranks merge with max().
    const t = buildRoleGrantTable([
      row({ id: 1, key: "SUPER_ADMIN", rank: 0, grantsAllPermissions: true }),
      row({ id: 2, key: "ADMIN", rank: 0 }),
    ]);
    expect(t.ranks.SUPER_ADMIN).toBe(3);
    expect(t.ranks.ADMIN).toBe(2);
  });
});

describe("grant table cache", () => {
  it("serves the second call from cache without a second query", async () => {
    roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER" })]);
    await getRoleGrantTable();
    await getRoleGrantTable();
    expect(roleFindMany).toHaveBeenCalledTimes(1);
  });

  it("invalidation actually invalidates — a revoked grant is gone on the next call", async () => {
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "MANAGER", permissions: [{ permission: "payment.refund" }] }),
    ]);
    const before = await getRoleGrantTable();
    expect(before.grantsByRole.MANAGER).toEqual(["payment.refund", ...BASELINE_PERMISSIONS]);

    // An operator revokes it. Without invalidation the cache keeps granting
    // for up to the TTL, which is the security bug this exists to prevent.
    roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER", permissions: [] })]);
    expect((await getRoleGrantTable()).grantsByRole.MANAGER).toEqual([
      "payment.refund",
      ...BASELINE_PERMISSIONS,
    ]);

    invalidateRoleGrantCache();
    // Revoked down to the floor, which is not revocable.
    expect((await getRoleGrantTable()).grantsByRole.MANAGER).toEqual([...BASELINE_PERMISSIONS]);
    expect(roleFindMany).toHaveBeenCalledTimes(2);
  });

  it("expires on its own after the TTL", async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER" })]);
      await getRoleGrantTable();
      now += ROLE_GRANT_CACHE_TTL_MS - 1;
      await getRoleGrantTable();
      expect(roleFindMany).toHaveBeenCalledTimes(1);
      now += 2;
      await getRoleGrantTable();
      expect(roleFindMany).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not let an in-flight load reinstall a table invalidated while it ran", async () => {
    // Same race, and the same generation-counter fix, as lib/trafficStoreMap.ts:
    // a load that started before an invalidation must not pin its stale result
    // for a fresh full TTL afterwards.
    let release!: (rows: RoleGrantRow[]) => void;
    roleFindMany.mockReturnValueOnce(
      new Promise<RoleGrantRow[]>((resolve) => {
        release = resolve;
      }),
    );
    const inFlight = getRoleGrantTable();

    invalidateRoleGrantCache();
    release([row({ id: 1, key: "MANAGER", permissions: [{ permission: "payment.refund" }] })]);
    await inFlight;

    roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER", permissions: [] })]);
    expect((await getRoleGrantTable()).grantsByRole.MANAGER).toEqual([...BASELINE_PERMISSIONS]);
  });
});

describe("resolvePermissionAccess — enum fallback", () => {
  it("a staff member with roleId = null and role = MANAGER gets exactly permissionsForBuiltInRole('MANAGER')", async () => {
    roleFindMany.mockResolvedValue([]); // migrated, not yet seeded
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: null });

    const expected = permissionsForBuiltInRole("MANAGER");
    expect(expected.length).toBeGreaterThan(0);

    for (const permission of expected) {
      const r = await resolvePermissionAccess({ userId: "u1", permission, impersonate: null });
      expect({ permission, allowed: r.allowed }).toEqual({ permission, allowed: true });
      expect(r.viaEnumFallback).toBe(true);
    }

    // ...and nothing beyond it. admin.settings and staff.manage are the two a
    // MANAGER most plausibly gets handed by accident.
    for (const permission of ["admin.settings", "staff.manage", "accounting.close"]) {
      expect(expected).not.toContain(permission);
      const r = await resolvePermissionAccess({ userId: "u1", permission, impersonate: null });
      expect({ permission, allowed: r.allowed }).toEqual({ permission, allowed: false });
    }
  });

  it("prefers the linked Role over the enum when roleId resolves", async () => {
    // The deployment revoked payment.refund from its Manager role. The enum
    // still says MANAGER; the database wins.
    roleFindMany.mockResolvedValue([row({ id: 9, key: "MANAGER", rank: 1, permissions: [] })]);
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: 9 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "payment.refund",
      impersonate: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.viaEnumFallback).toBe(false);
  });

  it("falls back to the enum when roleId points at a Role that no longer exists", async () => {
    // The FK is ON DELETE SET NULL, so this is the narrow window between a
    // role being deleted and the grant-table cache noticing.
    roleFindMany.mockResolvedValue([row({ id: 9, key: "ADMIN", rank: 2 })]);
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: 404 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "payment.refund",
      impersonate: null,
    });
    expect(r.viaEnumFallback).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it("still lets the database win on the fallback path when it knows the key", async () => {
    // Falling back means falling back to the role KEY, not past the database.
    // A deployment that revoked payment.refund from Manager has revoked it,
    // even for a staff member whose roleId link is broken.
    roleFindMany.mockResolvedValue([row({ id: 9, key: "MANAGER", rank: 1, permissions: [] })]);
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: 404 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "payment.refund",
      impersonate: null,
    });
    expect(r.viaEnumFallback).toBe(true);
    expect(r.allowed).toBe(false);
  });

  it("gives an unlinked SUPER_ADMIN the wildcard, not a frozen list", async () => {
    roleFindMany.mockResolvedValue([]);
    staffFindFirst.mockResolvedValue({ role: "SUPER_ADMIN", roleId: null });
    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "reticulation.splines",
      impersonate: null,
    });
    expect(r.allowed).toBe(true);
    expect(r.viaWildcard).toBe(true);
  });
});

describe("resolvePermissionAccess — staff membership is what grants access", () => {
  it("denies a session with no ACTIVE staff row", async () => {
    roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER" })]);
    staffFindFirst.mockResolvedValue(null);
    const r = await resolvePermissionAccess({
      userId: "portal-user",
      permission: "sales.read",
      impersonate: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.noActiveStaff).toBe(true);
  });

  it("still lets the first user through while no privileged staff exist", async () => {
    roleFindMany.mockResolvedValue([]);
    staffFindFirst.mockResolvedValue(null);
    staffCount.mockResolvedValue(0);
    const r = await resolvePermissionAccess({
      userId: "first-user",
      permission: "staff.manage",
      impersonate: null,
    });
    expect(r.allowed).toBe(true);
    expect(r.bootstrapBypass).toBe(true);
  });

  it("does not pay for the privileged-count query on the happy path", async () => {
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "MANAGER", rank: 1, permissions: [{ permission: "payment.refund" }] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: 1 });
    await resolvePermissionAccess({
      userId: "u1",
      permission: "payment.refund",
      impersonate: null,
    });
    expect(staffCount).not.toHaveBeenCalled();
  });

  it("filters on isActive, so deactivating someone revokes immediately", async () => {
    roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER" })]);
    staffFindFirst.mockResolvedValue(null);
    await resolvePermissionAccess({ userId: "u1", permission: "sales.read", impersonate: null });
    expect(staffFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", isActive: true } }),
    );
  });
});

describe("resolvePermissionAccess — { anyOf } is one decision, not one per key", () => {
  const SCREENS = { anyOf: ["sales.read", "reporting.read", "pos.operate"] };

  it("reads the staff row once and skips the privileged count when a later key is held", async () => {
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "CLERK", permissions: [{ permission: "pos.operate" }] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "DESIGNER", roleId: 1 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: SCREENS,
      impersonate: null,
    });

    expect(r.allowed).toBe(true);
    expect(r.bootstrapBypass).toBe(false);
    expect(staffFindFirst).toHaveBeenCalledTimes(1);
    expect(staffCount).not.toHaveBeenCalled();
  });

  it("counts privileged staff once, only after every key has missed", async () => {
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "CLERK", permissions: [{ permission: "catalog.read" }] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "DESIGNER", roleId: 1 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: SCREENS,
      impersonate: null,
    });

    expect(r.allowed).toBe(false);
    expect(staffFindFirst).toHaveBeenCalledTimes(1);
    expect(staffCount).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePermissionAccess — { also } answers further keys from the same read", () => {
  const ALSO = ["catalog.cost", "pos.operate"];
  const CLERK = row({
    id: 1,
    key: "CLERK",
    permissions: [{ permission: "inventory.read" }, { permission: "catalog.cost" }],
  });

  it("answers each key from the caller's grants, with one staff read and no privileged count", async () => {
    roleFindMany.mockResolvedValue([CLERK]);
    staffFindFirst.mockResolvedValue({ role: "DESIGNER", roleId: 1 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "inventory.read",
      impersonate: null,
      also: ALSO,
    });

    expect(r.allowed).toBe(true);
    expect(r.holds).toEqual({ "catalog.cost": true, "pos.operate": false });
    expect(staffFindFirst).toHaveBeenCalledTimes(1);
    expect(staffCount).not.toHaveBeenCalled();
  });

  it("never lets the bootstrap safeguard grant an extra key to someone the gate admitted by grant", async () => {
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "CLERK", permissions: [{ permission: "inventory.read" }] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "DESIGNER", roleId: 1 });
    staffCount.mockResolvedValue(0); // no privileged staff: the safeguard would admit anything

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "inventory.read",
      impersonate: null,
      also: ALSO,
    });

    expect(r.holds).toEqual({ "catalog.cost": false, "pos.operate": false });
    expect(staffCount).not.toHaveBeenCalled();
  });

  it("a request the bootstrap safeguard admitted holds every extra key, as it holds every route", async () => {
    roleFindMany.mockResolvedValue([]);
    staffFindFirst.mockResolvedValue(null);
    staffCount.mockResolvedValue(0);

    const r = await resolvePermissionAccess({
      userId: "first-user",
      permission: "inventory.read",
      impersonate: null,
      also: ALSO,
    });

    expect(r.bootstrapBypass).toBe(true);
    expect(r.holds).toEqual({ "catalog.cost": true, "pos.operate": true });
  });

  it("no active staff row holds nothing", async () => {
    roleFindMany.mockResolvedValue([CLERK]);
    staffFindFirst.mockResolvedValue(null);

    const r = await resolvePermissionAccess({
      userId: "gone",
      permission: "inventory.read",
      impersonate: null,
      also: ALSO,
    });

    expect(r.allowed).toBe(false);
    expect(r.holds).toEqual({ "catalog.cost": false, "pos.operate": false });
  });

  it("answers for the impersonated role, so an admin sees what that role would", async () => {
    roleFindMany.mockResolvedValue([
      row({
        id: 1,
        key: "ADMIN",
        rank: 90,
        permissions: [{ permission: "inventory.read" }, { permission: "catalog.cost" }],
      }),
      row({ id: 2, key: "COUNTER", permissions: [{ permission: "inventory.read" }] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "ADMIN", roleId: 1 });

    const as = (impersonate: string | null) =>
      resolvePermissionAccess({
        userId: "a1",
        permission: "inventory.read",
        impersonate,
        also: ALSO,
      });

    expect((await as(null)).holds["catalog.cost"]).toBe(true);
    expect((await as("COUNTER")).holds["catalog.cost"]).toBe(false);
  });

  it("viewing as another role never adds a key the viewer's own role lacks", async () => {
    // An ADMIN whose Role was edited to drop View cost, viewing as a MANAGER
    // that keeps it: the gate admits (both hold inventory.read), and the answer
    // for the key narrows to what both roles hold. Otherwise any such admin
    // gets cost back by viewing as a role that has it.
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "ADMIN", rank: 90, permissions: [{ permission: "inventory.read" }] }),
      row({
        id: 2,
        key: "MANAGER",
        rank: 50,
        permissions: [{ permission: "inventory.read" }, { permission: "catalog.cost" }],
      }),
      row({ id: 3, key: "SUPER_ADMIN", rank: 100, grantsAllPermissions: true }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "ADMIN", roleId: 1 });

    const as = (impersonate: string | null) =>
      resolvePermissionAccess({
        userId: "a1",
        permission: "inventory.read",
        impersonate,
        also: ["catalog.cost"],
      });

    expect((await as(null)).holds["catalog.cost"]).toBe(false);
    const viewing = await as("MANAGER");
    expect(viewing.allowed).toBe(true);
    expect(viewing.holds["catalog.cost"]).toBe(false);

    const list = await resolveRoleListAccess({
      userId: "a1",
      allowedRoles: ["MANAGER", "ADMIN"],
      impersonate: "MANAGER",
      also: ["catalog.cost"],
    });
    expect(list.allowed).toBe(true);
    expect(list.holds).toEqual({ "catalog.cost": false });

    // It only narrows: an owner viewing as that MANAGER still sees what MANAGER sees.
    staffFindFirst.mockResolvedValue({ role: "SUPER_ADMIN", roleId: 3 });
    expect((await as("MANAGER")).holds["catalog.cost"]).toBe(true);
  });
});

describe("resolveRoleListAccess — { also }", () => {
  it("answers keys from the caller's Role though the gate itself reads the enum", async () => {
    // A MANAGER whose Role was edited to drop View cost: the role list still
    // admits them on the enum, and the answer for the key comes from the Role.
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "MANAGER", rank: 50, permissions: [{ permission: "inventory.read" }] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: 1 });

    const r = await resolveRoleListAccess({
      userId: "m1",
      allowedRoles: ["MANAGER", "ADMIN"],
      impersonate: null,
      also: ["catalog.cost"],
    });

    expect(r.allowed).toBe(true);
    expect(r.holds).toEqual({ "catalog.cost": false });
    expect(staffFindFirst).toHaveBeenCalledTimes(1);
  });

  it("a first user admitted by the safeguard holds every key, even on a list naming DESIGNER", async () => {
    // No staff row and nobody privileged: decideRoleAccess admits them as
    // DESIGNER, a plain match when the list names DESIGNER. It is still the
    // safeguard admitting them, so the answers must match the list without it.
    staffFindFirst.mockResolvedValue(null);
    staffCount.mockResolvedValue(0);

    for (const allowedRoles of [["DESIGNER", "MANAGER"], ["MANAGER"]]) {
      const r = await resolveRoleListAccess({
        userId: "first-user",
        allowedRoles,
        impersonate: null,
        also: ["catalog.cost"],
      });
      expect({ allowedRoles, allowed: r.allowed, holds: r.holds }).toEqual({
        allowedRoles,
        allowed: true,
        holds: { "catalog.cost": true },
      });
    }
  });

  it("does not read the grant table when no key is asked for", async () => {
    staffFindFirst.mockResolvedValue({ role: "MANAGER", roleId: 1 });

    const r = await resolveRoleListAccess({
      userId: "m1",
      allowedRoles: ["MANAGER"],
      impersonate: null,
    });

    expect(r.allowed).toBe(true);
    expect(r.holds).toEqual({});
    expect(roleFindMany).not.toHaveBeenCalled();
  });
});
