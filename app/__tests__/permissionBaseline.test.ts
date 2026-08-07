// /app/__tests__/permissionBaseline.test.ts
//
// PLACEHOLDER TEST — Grade: A (mocked-Prisma wiring only, not SQL behavior)
//
// Most of this file is pure: buildRoleGrantTable and the catalog helpers take
// literal values and touch nothing. The Prisma mock is an isolation shim for
// the two places that read — resolvePermissionAccess (canned staff and Role
// rows) and the seeder recording client, which stands in for a round trip and
// verifies none of Prisma's own query behaviour. The real-DB assertions are in
// __tests__/integration/permissionBaseline.integration.test.ts.
//
// The baseline floor: `staff.self` is held by EVERY role, cannot be granted,
// cannot be revoked, and is never stored.
//
// Why this gets its own file rather than a couple of assertions bolted onto
// permissionCatalog.test.ts: the guarantee is not a property of one function.
// It is "there is no path from a role to a decision that loses the floor", and
// the paths are three — the catalog (built-in roles), the grant table (database
// roles, including keys the catalog has never heard of), and the seeder (which
// must NOT write it as a row). A regression in any one of them breaks clock-in
// for whoever holds that role, with a 403 and no explanation, so all three are
// pinned in one place where the invariant is legible.
//
// The negative half matters as much as the positive: the floor sits under every
// ROLE, not under every session. Someone with no active staff row still gets
// nothing, and a role with no grants gets the floor and nothing else.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    role: { findMany: jest.fn() },
    staffMember: { findFirst: jest.fn(), count: jest.fn() },
  },
}));

import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  BASELINE_PERMISSIONS,
  BUILT_IN_ROLES,
  PERMISSION_KEYS,
  getPermission,
  isBaselinePermission,
  isPermissionKey,
  permissionsForBuiltInRole,
  stripBaselinePermissions,
  withBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import {
  buildRoleGrantTable,
  invalidateRoleGrantCache,
  resolvePermissionAccess,
  type RoleGrantRow,
} from "@/lib/auth/permissionResolver";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";

const roleFindMany = prisma.role.findMany as jest.Mock;
const staffFindFirst = prisma.staffMember.findFirst as jest.Mock;
const staffCount = prisma.staffMember.count as jest.Mock;

function row(over: Partial<RoleGrantRow> & Pick<RoleGrantRow, "id" | "key">): RoleGrantRow {
  return { rank: 0, grantsAllPermissions: false, permissions: [], ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateRoleGrantCache();
  // Bootstrap door SHUT. Every denial asserted below must be a real denial and
  // not the "no privileged staff exist yet" bypass, which grants everything.
  staffCount.mockResolvedValue(5);
});

describe("the baseline is a real, declared permission", () => {
  it("is exactly staff.self today", () => {
    expect([...BASELINE_PERMISSIONS]).toEqual(["staff.self"]);
  });

  it("is declared in the catalog, so the admin UI can label it instead of hiding it", () => {
    // The GUI shows it checked-and-disabled. A key with no PermissionDef would
    // render as a blank row or be silently dropped, which is how "why can this
    // person clock in" stops having an answer.
    for (const key of BASELINE_PERMISSIONS) {
      expect(isPermissionKey(key)).toBe(true);
      expect(PERMISSION_KEYS).toContain(key);
      expect(getPermission(key)?.domain).toBe("staff");
    }
  });

  it("is not marked sensitive — it grants no power over anyone else", () => {
    // Editing someone ELSE's time is staff.time; creating staff is staff.manage.
    // If the baseline ever needs a sensitive flag, it does not belong in the
    // baseline.
    for (const key of BASELINE_PERMISSIONS) {
      expect(getPermission(key)?.sensitive).toBeFalsy();
    }
    expect(isBaselinePermission("staff.time")).toBe(false);
    expect(isBaselinePermission("staff.manage")).toBe(false);
  });
});

describe("withBaselinePermissions / stripBaselinePermissions", () => {
  it("adds the floor without duplicating or reordering what was there", () => {
    expect(withBaselinePermissions(["sales.read"])).toEqual(["sales.read", "staff.self"]);
    expect(withBaselinePermissions(["staff.self", "sales.read"])).toEqual([
      "staff.self",
      "sales.read",
    ]);
    expect(withBaselinePermissions([])).toEqual(["staff.self"]);
  });

  it("is idempotent — applying it twice is applying it once", () => {
    const once = withBaselinePermissions(["sales.read"]);
    expect(withBaselinePermissions(once)).toEqual(once);
  });

  it("strips the floor out for storage, leaving everything else alone", () => {
    expect(stripBaselinePermissions(["sales.read", "staff.self"])).toEqual(["sales.read"]);
    expect(stripBaselinePermissions(["staff.self"])).toEqual([]);
    // Not a prefix match: staff.time and staff.read are ordinary permissions.
    expect(stripBaselinePermissions(["staff.time", "staff.read"])).toEqual([
      "staff.time",
      "staff.read",
    ]);
  });

  it("round-trips: strip then add gets the floor back", () => {
    const stored = stripBaselinePermissions(["sales.read", "staff.self"]);
    expect(withBaselinePermissions(stored)).toEqual(["sales.read", "staff.self"]);
  });
});

describe("every built-in role holds the baseline", () => {
  it("all eight of them, wildcard and lateral alike", () => {
    const missing = BUILT_IN_ROLES.filter((r) =>
      BASELINE_PERMISSIONS.some((b) => !permissionsForBuiltInRole(r.key).includes(b)),
    ).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("including the most tightly scoped one — INSTALLER cannot do much, but can clock in", () => {
    const installer = permissionsForBuiltInRole("INSTALLER");
    expect(installer).toContain("staff.self");
    // ...and the floor did not smuggle anything else in with it.
    expect(installer).not.toContain("staff.time");
    expect(installer).not.toContain("staff.manage");
  });

  it("gives a role key the catalog has never heard of the floor and nothing else", () => {
    // Reached through requirePermission's StaffRole fallback: a real person on a
    // real shift whose role has no definition here. [] would mean they cannot
    // clock in, which is the case the floor exists for.
    expect(permissionsForBuiltInRole("FLOOR_LEAD")).toEqual([...BASELINE_PERMISSIONS]);
  });
});

describe("buildRoleGrantTable puts the floor under every database role", () => {
  it("a role with zero RolePermission rows still holds it", () => {
    const t = buildRoleGrantTable([row({ id: 1, key: "SEASONAL", permissions: [] })]);
    expect(t.grantsByRole.SEASONAL).toEqual([...BASELINE_PERMISSIONS]);
  });

  it("a role key the catalog has never seen still holds it", () => {
    // The load-bearing case. A deployment invents "Floor Lead" through the admin
    // GUI; the GUI never offers staff.self as a checkbox, so nothing in the write
    // path could have added it. It holds it anyway.
    const t = buildRoleGrantTable([
      row({ id: 2, key: "FLOOR_LEAD", rank: 1, permissions: [{ permission: "sales.discount" }] }),
    ]);
    expect(t.grantsByRole.FLOOR_LEAD).toEqual(["sales.discount", "staff.self"]);
  });

  it("does not lose a role's real grants to make room for it", () => {
    const t = buildRoleGrantTable([
      row({
        id: 3,
        key: "MANAGER",
        rank: 1,
        permissions: [{ permission: "payment.refund" }, { permission: "staff.time" }],
      }),
    ]);
    expect(t.grantsByRole.MANAGER).toEqual(["payment.refund", "staff.time", "staff.self"]);
  });

  it("does not duplicate it if a stray row somehow stored it", () => {
    // Storage paths strip it, but a hand-written SQL statement or a restored
    // dump from before this change can still produce the row.
    const t = buildRoleGrantTable([
      row({ id: 4, key: "REGISTER", permissions: [{ permission: "staff.self" }] }),
    ]);
    expect(t.grantsByRole.REGISTER).toEqual(["staff.self"]);
  });
});

describe("resolvePermissionAccess honours the floor", () => {
  it("grants it to a custom role that holds nothing else", async () => {
    roleFindMany.mockResolvedValue([row({ id: 9, key: "FLOOR_LEAD", permissions: [] })]);
    staffFindFirst.mockResolvedValue({ role: "DESIGNER", roleId: 9 });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "staff.self",
      impersonate: null,
    });
    expect({ allowed: r.allowed, bootstrap: r.bootstrapBypass }).toEqual({
      allowed: true,
      bootstrap: false,
    });
  });

  it("...and still denies that role everything else", async () => {
    roleFindMany.mockResolvedValue([row({ id: 9, key: "FLOOR_LEAD", permissions: [] })]);
    staffFindFirst.mockResolvedValue({ role: "DESIGNER", roleId: 9 });

    for (const permission of ["sales.read", "staff.time", "staff.manage"]) {
      const r = await resolvePermissionAccess({ userId: "u1", permission, impersonate: null });
      expect({ permission, allowed: r.allowed }).toEqual({ permission, allowed: false });
    }
  });

  it("grants it on the enum-fallback path, where no Role row exists at all", async () => {
    roleFindMany.mockResolvedValue([]); // migrated, never seeded
    staffFindFirst.mockResolvedValue({ role: "WAREHOUSE", roleId: null });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "staff.self",
      impersonate: null,
    });
    expect(r.allowed).toBe(true);
    expect(r.viaEnumFallback).toBe(true);
    expect(r.bootstrapBypass).toBe(false);
  });

  it("grants it to a staff member whose role key nothing recognises", async () => {
    // Neither the database nor the catalog knows "FLOOR_LEAD" here. They can
    // still clock in.
    roleFindMany.mockResolvedValue([]);
    staffFindFirst.mockResolvedValue({ role: "FLOOR_LEAD", roleId: null });

    const r = await resolvePermissionAccess({
      userId: "u1",
      permission: "staff.self",
      impersonate: null,
    });
    expect({ allowed: r.allowed, bootstrap: r.bootstrapBypass }).toEqual({
      allowed: true,
      bootstrap: false,
    });
  });

  it("does NOT give it to a session with no active staff row", async () => {
    // The floor is under every ROLE, not under every logged-in human. A client
    // portal user, or someone deactivated this morning, holds nothing — and
    // "deactivating someone revokes access immediately" has to stay true of
    // clock-in above all.
    roleFindMany.mockResolvedValue([row({ id: 1, key: "MANAGER" })]);
    staffFindFirst.mockResolvedValue(null);

    const r = await resolvePermissionAccess({
      userId: "portal-user",
      permission: "staff.self",
      impersonate: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.noActiveStaff).toBe(true);
  });

  it("survives an impersonation down into a role with no grants", async () => {
    roleFindMany.mockResolvedValue([
      row({ id: 1, key: "ADMIN", rank: 2 }),
      row({ id: 2, key: "FLOOR_LEAD", permissions: [] }),
    ]);
    staffFindFirst.mockResolvedValue({ role: "ADMIN", roleId: 1 });

    const r = await resolvePermissionAccess({
      userId: "adm",
      permission: "staff.self",
      impersonate: "FLOOR_LEAD",
    });
    expect(r.effectiveUserRole).toBe("FLOOR_LEAD");
    expect(r.allowed).toBe(true);
  });
});

describe("the seeder never writes the baseline as a row", () => {
  // Wiring-level: a hand-rolled client records what syncBuiltInRoles would
  // write, so the diff logic runs for real without a database. The same
  // assertion against Postgres is in
  // __tests__/integration/permissionBaseline.integration.test.ts — that one is
  // the authority, this one is the copy that runs on every unit run.
  function recordingClient() {
    const created: { roleId: number; permission: string }[] = [];
    let nextId = 1;
    const client = {
      role: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async () => ({ id: nextId++ })),
        update: jest.fn(),
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        createMany: jest
          .fn()
          .mockImplementation(async (args: { data: { roleId: number; permission: string }[] }) => {
            created.push(...args.data);
            return { count: args.data.length };
          }),
      },
    };
    return { client: client as unknown as PrismaClient, created };
  }

  it("seeds every built-in role with no staff.self row anywhere", async () => {
    const { client, created } = recordingClient();
    const result = await syncBuiltInRoles({ prisma: client });

    expect(result.rolesCreated).toBe(BUILT_IN_ROLES.length);
    expect(created.length).toBeGreaterThan(0);
    const baselineRows = created.filter((r) => isBaselinePermission(r.permission));
    expect(baselineRows).toEqual([]);
  });

  it("still seeds the grantable staff permissions, so the strip is surgical", async () => {
    // The failure this guards: stripping by prefix, or stripping the whole
    // staff domain, and quietly taking staff.time away from every Manager.
    const { client, created } = recordingClient();
    await syncBuiltInRoles({ prisma: client });
    const permissions = created.map((r) => r.permission);
    expect(permissions).toContain("staff.time");
    expect(permissions).toContain("staff.read");
  });
});
