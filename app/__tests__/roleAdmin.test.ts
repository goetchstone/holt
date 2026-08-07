// /app/__tests__/roleAdmin.test.ts
//
// The pure half of the custom-role admin API: validation, serialization, and
// the self-lockout guard's counting rule. No DB — the route-level behaviour
// (transactions, 409 bodies, cache invalidation) is exercised against real
// Postgres in __tests__/integration/roleAdminApi.integration.test.ts.
//
// The lockout tests here are the ones that matter most. countStaffHolding is
// asked about a state that does not exist yet — the rows a PUT or DELETE is
// ABOUT to write — so it is the only part of the guard that can be tested
// without simulating a half-applied write.

import { StaffRole } from "@prisma/client";

import {
  BASELINE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
} from "@/lib/auth/permissionCatalog";
import type { RoleGrantRow } from "@/lib/auth/permissionResolver";
import {
  LOCKOUT_PERMISSION,
  ROLE_SELECT,
  type RoleRow,
  type StaffRoleLink,
  buildCatalogPayload,
  countStaffHolding,
  effectivePermissions,
  lockoutMessage,
  parseOptionalDescription,
  parseOptionalRank,
  parsePermissionList,
  parseRoleName,
  toRoleDetail,
  toRoleSummary,
  validateRoleKey,
  withPermissionsReplaced,
  withRoleRemoved,
  withStaffReassigned,
} from "@/lib/auth/roleAdmin";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function roleRow(over: Partial<RoleRow> = {}): RoleRow {
  return {
    id: 1,
    key: "FLOOR_LEAD",
    name: "Floor Lead",
    description: "Runs the floor",
    isSystem: false,
    grantsAllPermissions: false,
    grantsCustomized: false,
    rank: 0,
    permissions: [{ permission: "sales.read" }, { permission: "sales.write" }],
    ...over,
  };
}

function grantRow(over: Partial<RoleGrantRow> = {}): RoleGrantRow {
  return {
    id: 1,
    key: "FLOOR_LEAD",
    rank: 0,
    grantsAllPermissions: false,
    permissions: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

describe("validateRoleKey", () => {
  it.each(["FLOOR_LEAD", "AB", "A".repeat(40), "TIER_2", "X9_Y"])("accepts %s", (key) => {
    expect(validateRoleKey(key)).toEqual({ ok: true, value: key });
  });

  it.each([
    ["floor_lead", "lowercase"],
    ["Floor_Lead", "mixed case"],
    ["A", "one character"],
    ["A".repeat(41), "41 characters"],
    ["FLOOR-LEAD", "a hyphen"],
    ["FLOOR LEAD", "a space"],
    ["FLOOR.LEAD", "a dot"],
  ])("rejects %s (%s)", (key) => {
    const result = validateRoleKey(key);
    expect(result.ok).toBe(false);
    // The message has to say what a valid key looks like -- the operator typed
    // what they thought was one.
    if (!result.ok) expect(result.error).toMatch(/uppercase A-Z, digits and underscore/);
  });

  it.each(Object.values(StaffRole))("refuses %s: it is a built-in StaffRole value", (key) => {
    const result = validateRoleKey(key);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(key);
      expect(result.error).toMatch(/reserved for the built-in role/);
    }
  });

  it("rejects a missing or non-string key", () => {
    for (const bad of [undefined, null, 42, {}, "", "   "]) {
      expect(validateRoleKey(bad).ok).toBe(false);
    }
  });

  it("does not silently upcase a lowercase key", () => {
    // Coercing would create a role under a key the operator did not type, which
    // is then persisted in staff links and config presets forever.
    expect(validateRoleKey("floor_lead")).toEqual(expect.objectContaining({ ok: false }));
  });
});

// ---------------------------------------------------------------------------
// Permission-list validation
// ---------------------------------------------------------------------------

describe("parsePermissionList", () => {
  it("accepts a list of real catalog keys, sorted and de-duplicated", () => {
    expect(parsePermissionList(["sales.write", "sales.read", "sales.read"])).toEqual({
      ok: true,
      value: ["sales.read", "sales.write"],
    });
  });

  it("refuses the WHOLE request and names the unknown key", () => {
    const result = parsePermissionList(["sales.read", "sales.teleport", "sales.write"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sales.teleport");
      // Naming it is the point: a dropped key is a grant the operator believes
      // they made.
      expect(result.error).toMatch(/No part of this request was applied/);
    }
  });

  it("never returns a partial list when one key is unknown", () => {
    const result = parsePermissionList(["sales.teleport"]);
    expect(result).not.toHaveProperty("value");
  });

  it.each(BASELINE_PERMISSIONS)("drops the baseline key %s silently", (baseline) => {
    const result = parsePermissionList(["sales.read", baseline]);
    expect(result).toEqual({ ok: true, value: ["sales.read"] });
  });

  it("accepts a body that is nothing BUT the baseline, and stores none of it", () => {
    expect(parsePermissionList([...BASELINE_PERMISSIONS])).toEqual({ ok: true, value: [] });
  });

  it("rejects a non-array, a non-string entry, and an empty key", () => {
    expect(parsePermissionList("sales.read").ok).toBe(false);
    expect(parsePermissionList(undefined).ok).toBe(false);
    expect(parsePermissionList([1]).ok).toBe(false);
    expect(parsePermissionList([""]).ok).toBe(false);
  });

  it("accepts an empty list — a role that grants nothing beyond the floor", () => {
    expect(parsePermissionList([])).toEqual({ ok: true, value: [] });
  });
});

describe("scalar parsers", () => {
  it("parseRoleName requires non-empty text and trims it", () => {
    expect(parseRoleName("  Floor Lead  ")).toEqual({ ok: true, value: "Floor Lead" });
    expect(parseRoleName("   ").ok).toBe(false);
    expect(parseRoleName(undefined).ok).toBe(false);
  });

  it("parseOptionalDescription distinguishes absent from cleared", () => {
    expect(parseOptionalDescription(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseOptionalDescription(null)).toEqual({ ok: true, value: null });
    expect(parseOptionalDescription("  ")).toEqual({ ok: true, value: null });
    expect(parseOptionalDescription(" hi ")).toEqual({ ok: true, value: "hi" });
    expect(parseOptionalDescription(7).ok).toBe(false);
  });

  it("parseOptionalRank takes non-negative integers only", () => {
    expect(parseOptionalRank(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseOptionalRank(0)).toEqual({ ok: true, value: 0 });
    expect(parseOptionalRank(3)).toEqual({ ok: true, value: 3 });
    expect(parseOptionalRank(-1).ok).toBe(false);
    expect(parseOptionalRank(1.5).ok).toBe(false);
    expect(parseOptionalRank("2").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("effectivePermissions", () => {
  it("returns the stored rows, sorted, for an ordinary role", () => {
    expect(effectivePermissions(roleRow())).toEqual(["sales.read", "sales.write"]);
  });

  it("expands a wildcard role to the whole catalog rather than its zero rows", () => {
    // The Owner stores no RolePermission rows. Reporting [] would read in the
    // admin list as "grants nothing", which is the exact opposite of the truth.
    const owner = roleRow({ grantsAllPermissions: true, permissions: [] });
    expect(effectivePermissions(owner).length).toBe(
      PERMISSION_KEYS.length - BASELINE_PERMISSIONS.length,
    );
    expect(effectivePermissions(owner)).toContain("payment.refund");
  });

  it.each(BASELINE_PERMISSIONS)("never reports the baseline key %s as a grant", (baseline) => {
    expect(effectivePermissions(roleRow({ grantsAllPermissions: true }))).not.toContain(baseline);
    expect(
      effectivePermissions(roleRow({ permissions: [{ permission: baseline }] })),
    ).not.toContain(baseline);
  });
});

describe("toRoleSummary / toRoleDetail", () => {
  it("carries every contract field", () => {
    expect(toRoleSummary(roleRow(), 4)).toEqual({
      id: 1,
      key: "FLOOR_LEAD",
      name: "Floor Lead",
      description: "Runs the floor",
      isSystem: false,
      grantsAllPermissions: false,
      grantsCustomized: false,
      rank: 0,
      permissionCount: 2,
      staffCount: 4,
    });
  });

  it("counts a wildcard role's permissions as the catalog, not as zero", () => {
    const summary = toRoleSummary(roleRow({ grantsAllPermissions: true, permissions: [] }), 1);
    expect(summary.permissionCount).toBe(PERMISSION_KEYS.length - BASELINE_PERMISSIONS.length);
  });

  it("detail is the summary plus permissions", () => {
    const detail = toRoleDetail(roleRow(), 0);
    expect(detail).toMatchObject(toRoleSummary(roleRow(), 0));
    expect(detail.permissions).toEqual(["sales.read", "sales.write"]);
  });

  it("ROLE_SELECT names every column the serializers read", () => {
    // Tripwire: a column dropped from the select would serialize as undefined
    // and the type checker would not object, because RoleRow's fields are all
    // required and Prisma's select result is inferred.
    for (const field of [
      "id",
      "key",
      "name",
      "description",
      "isSystem",
      "grantsAllPermissions",
      "grantsCustomized",
      "rank",
      "permissions",
    ]) {
      expect(ROLE_SELECT).toHaveProperty(field);
    }
  });
});

describe("buildCatalogPayload", () => {
  it("ships every domain and every permission", () => {
    const payload = buildCatalogPayload();
    expect(payload.domains).toHaveLength(PERMISSION_DOMAINS.length);
    expect(payload.permissions).toHaveLength(PERMISSIONS.length);
  });

  it("normalizes `sensitive` to a boolean on every entry", () => {
    // PermissionDef leaves it optional; the wire contract does not, and a UI
    // that warns on `sensitive` must not have to treat undefined as false.
    for (const p of buildCatalogPayload().permissions) {
      expect(typeof p.sensitive).toBe("boolean");
    }
    const refund = buildCatalogPayload().permissions.find((p) => p.key === "payment.refund");
    expect(refund?.sensitive).toBe(true);
  });

  it("includes the baseline permission so the UI can render it as always-on", () => {
    const keys = buildCatalogPayload().permissions.map((p) => p.key);
    for (const baseline of BASELINE_PERMISSIONS) expect(keys).toContain(baseline);
  });
});

// ---------------------------------------------------------------------------
// The self-lockout guard
// ---------------------------------------------------------------------------

describe("countStaffHolding", () => {
  const manageRole = grantRow({
    id: 10,
    key: "FLOOR_LEAD",
    permissions: [{ permission: LOCKOUT_PERMISSION }],
  });
  const plainRole = grantRow({
    id: 11,
    key: "SHIPPER",
    permissions: [{ permission: "sales.read" }],
  });

  it("counts a staff member linked to a role that holds the permission", () => {
    const staff: StaffRoleLink[] = [{ role: "DESIGNER", roleId: 10 }];
    expect(countStaffHolding(LOCKOUT_PERMISSION, staff, [manageRole, plainRole])).toBe(1);
  });

  it("does not count one linked to a role that does not", () => {
    const staff: StaffRoleLink[] = [{ role: "DESIGNER", roleId: 11 }];
    expect(countStaffHolding(LOCKOUT_PERMISSION, staff, [manageRole, plainRole])).toBe(0);
  });

  it("counts a wildcard role as holding it, rows or no rows", () => {
    const owner = grantRow({
      id: 12,
      key: "OWNERISH",
      grantsAllPermissions: true,
      permissions: [],
    });
    const staff: StaffRoleLink[] = [{ role: "DESIGNER", roleId: 12 }];
    expect(countStaffHolding(LOCKOUT_PERMISSION, staff, [owner])).toBe(1);
  });

  it("counts SUPER_ADMIN as a wildcard even when the DB row forgot the flag", () => {
    // buildRoleGrantTable seeds wildcardRoles from the compile-time built-ins,
    // so a row that lost grantsAllPermissions cannot demote the Owner. The
    // guard has to agree with the permission check about that, or it would
    // refuse a safe delete.
    const owner = grantRow({
      id: 13,
      key: "SUPER_ADMIN",
      grantsAllPermissions: false,
      permissions: [],
    });
    expect(
      countStaffHolding(LOCKOUT_PERMISSION, [{ role: "SUPER_ADMIN", roleId: 13 }], [owner]),
    ).toBe(1);
  });

  it("falls back to the StaffRole enum when roleId is NULL", () => {
    // Exactly what resolvePermissionAccess does for a staff member created by a
    // code path that predates the roleId column.
    expect(countStaffHolding(LOCKOUT_PERMISSION, [{ role: "ADMIN", roleId: null }], [])).toBe(1);
    expect(countStaffHolding(LOCKOUT_PERMISSION, [{ role: "DESIGNER", roleId: null }], [])).toBe(0);
  });

  it("falls back to the enum when roleId points at a role that no longer exists", () => {
    // This is the state a DELETE leaves behind if the guard is wrong: Prisma's
    // SET NULL drops the link and the holder silently reverts to their enum.
    expect(countStaffHolding(LOCKOUT_PERMISSION, [{ role: "ADMIN", roleId: 999 }], [])).toBe(1);
    expect(countStaffHolding(LOCKOUT_PERMISSION, [{ role: "DESIGNER", roleId: 999 }], [])).toBe(0);
  });

  it("returns 0 for an empty staff list — the bootstrap safeguard must not mask it", () => {
    // decidePermissionAccess grants any failing check while no privileged staff
    // exist. If the guard let that fire, it would report "someone still holds
    // staff.manage" precisely when nobody does.
    expect(countStaffHolding(LOCKOUT_PERMISSION, [], [manageRole])).toBe(0);
  });

  it("counts each holder once across a mixed population", () => {
    const staff: StaffRoleLink[] = [
      { role: "DESIGNER", roleId: 10 },
      { role: "DESIGNER", roleId: 10 },
      { role: "DESIGNER", roleId: 11 },
      { role: "ADMIN", roleId: null },
    ];
    expect(countStaffHolding(LOCKOUT_PERMISSION, staff, [manageRole, plainRole])).toBe(3);
  });
});

describe("pending-state helpers", () => {
  const roles: RoleGrantRow[] = [
    grantRow({ id: 10, key: "FLOOR_LEAD", permissions: [{ permission: LOCKOUT_PERMISSION }] }),
    grantRow({ id: 11, key: "SHIPPER", permissions: [{ permission: "sales.read" }] }),
  ];

  it("withPermissionsReplaced swaps only the named role's grants", () => {
    const next = withPermissionsReplaced(roles, 10, ["sales.read"]);
    expect(next.find((r) => r.id === 10)?.permissions).toEqual([{ permission: "sales.read" }]);
    expect(next.find((r) => r.id === 11)?.permissions).toEqual([{ permission: "sales.read" }]);
    // and does not mutate the input
    expect(roles[0].permissions).toEqual([{ permission: LOCKOUT_PERMISSION }]);
  });

  it("a PUT that revokes staff.manage from the last holder counts to zero", () => {
    const staff: StaffRoleLink[] = [{ role: "DESIGNER", roleId: 10 }];
    expect(countStaffHolding(LOCKOUT_PERMISSION, staff, roles)).toBe(1);
    expect(
      countStaffHolding(
        LOCKOUT_PERMISSION,
        staff,
        withPermissionsReplaced(roles, 10, ["sales.read"]),
      ),
    ).toBe(0);
  });

  it("withRoleRemoved drops the role, and withStaffReassigned moves its people", () => {
    const staff: StaffRoleLink[] = [{ role: "DESIGNER", roleId: 10 }];
    expect(withRoleRemoved(roles, 10).map((r) => r.id)).toEqual([11]);
    expect(withStaffReassigned(staff, 10, 11)).toEqual([{ role: "DESIGNER", roleId: 11 }]);
    expect(withStaffReassigned(staff, 10, null)).toEqual([{ role: "DESIGNER", roleId: null }]);
    expect(staff[0].roleId).toBe(10); // input untouched
  });

  it("a DELETE that reassigns the last holders into a powerless role counts to zero", () => {
    const staff: StaffRoleLink[] = [{ role: "DESIGNER", roleId: 10 }];
    expect(
      countStaffHolding(
        LOCKOUT_PERMISSION,
        withStaffReassigned(staff, 10, 11),
        withRoleRemoved(roles, 10),
      ),
    ).toBe(0);
  });

  it("the same DELETE is safe when an unlinked ADMIN is still on the payroll", () => {
    const staff: StaffRoleLink[] = [
      { role: "DESIGNER", roleId: 10 },
      { role: "ADMIN", roleId: null },
    ];
    expect(
      countStaffHolding(
        LOCKOUT_PERMISSION,
        withStaffReassigned(staff, 10, 11),
        withRoleRemoved(roles, 10),
      ),
    ).toBe(1);
  });
});

describe("lockoutMessage", () => {
  it("names the capability and says nobody could grant it back", () => {
    const message = lockoutMessage("Deleting Floor Lead");
    expect(message).toContain("Deleting Floor Lead");
    expect(message).toContain(LOCKOUT_PERMISSION);
    expect(message).toMatch(/grant it back/);
  });
});
