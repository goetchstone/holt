// /app/__tests__/permissionCatalog.test.ts
//
// The permission vocabulary is persisted: keys land in RolePermission rows and
// in committed config presets, so a typo or a rename is a migration rather than
// an edit. These tests guard the properties that make that safe.
//
// They also pin the built-in role grants. Those exist to reproduce today's
// behaviour exactly, so that introducing the permission layer is a no-op on day
// one -- if a grant here drifts, authorization silently changes for every
// deployment that never customised its roles.

import {
  BUILT_IN_ROLES,
  PERMISSIONS,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
  getPermission,
  isPermissionKey,
  permissionsForBuiltInRole,
} from "@/lib/auth/permissionCatalog";

describe("permission catalog", () => {
  it("has unique, well-formed keys", () => {
    // domain.action, lowercase, dot-separated. The key is a database value and
    // a config-preset value; loose formatting here becomes per-surface
    // escaping rules later.
    const seen = new Set<string>();
    for (const p of PERMISSIONS) {
      expect(p.key).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
      expect(seen.has(p.key)).toBe(false);
      seen.add(p.key);
    }
    expect(seen.size).toBe(PERMISSIONS.length);
  });

  it("every permission belongs to a declared domain", () => {
    const domains = new Set(PERMISSION_DOMAINS.map((d) => d.key));
    const orphans = PERMISSIONS.filter((p) => !domains.has(p.domain)).map((p) => p.key);
    expect(orphans).toEqual([]);
  });

  it("every permission is described in operator terms", () => {
    // The admin UI renders these next to a checkbox that changes who can move
    // money. "sales.discount" is not a description.
    const thin = PERMISSIONS.filter((p) => !p.label || p.description.trim().length < 20).map(
      (p) => p.key,
    );
    expect(thin).toEqual([]);
  });

  it("lookup helpers agree with the catalog", () => {
    expect(PERMISSION_KEYS.length).toBe(PERMISSIONS.length);
    expect(isPermissionKey("payment.refund")).toBe(true);
    expect(isPermissionKey("payment.reticulate")).toBe(false);
    expect(getPermission("payment.refund")?.domain).toBe("payment");
    expect(getPermission("nope")).toBeUndefined();
  });

  it("marks the capabilities that move money or grant power as sensitive", () => {
    // Not enforcement — these are identical to enforce. It drives the warning
    // in the admin UI and makes a bad custom role obvious in review.
    for (const key of [
      "payment.refund",
      "payment.void",
      "customer.credit.adjust",
      "inventory.adjust",
      "staff.manage",
      "admin.data",
      "accounting.close",
    ]) {
      expect(getPermission(key)?.sensitive).toBe(true);
    }
  });
});

describe("built-in roles", () => {
  it("grant only permissions that exist", () => {
    // A grant naming a deleted permission would silently do nothing, which is
    // the failure mode that makes people distrust the whole system.
    for (const role of BUILT_IN_ROLES) {
      const bad = permissionsForBuiltInRole(role.key).filter((k) => !isPermissionKey(k));
      expect({ role: role.key, bad }).toEqual({ role: role.key, bad: [] });
    }
  });

  it("cover every role in the StaffRole enum", () => {
    // A staff member holding a role with no definition would resolve to no
    // permissions and be locked out of their own job.
    const expected = [
      "SUPER_ADMIN",
      "ADMIN",
      "DESIGNER",
      "REGISTER",
      "MANAGER",
      "WAREHOUSE",
      "INSTALLER",
      "MARKETING",
      // The operating roles (2026-08-21). The eight above were the original
      // built-in set; these name the jobs a furniture
      // retailer actually has, so nobody is handed the whole store to do one.
      "GENERAL_MANAGER",
      "DEPARTMENT_HEAD",
      "BUYER",
      "DATA_ENTRY",
      "HR",
      "DISPATCH",
      "CUSTOMER_SERVICE",
    ].sort();
    expect(BUILT_IN_ROLES.map((r) => r.key).sort()).toEqual(expected);
  });

  it("give SUPER_ADMIN everything, including future permissions", () => {
    expect(permissionsForBuiltInRole("SUPER_ADMIN").sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("keep impersonation owner-only: ADMIN has everything except that", () => {
    const admin = permissionsForBuiltInRole("ADMIN");
    expect(admin).not.toContain("admin.impersonate");
    expect(admin.length).toBe(PERMISSIONS.length - 1);
  });

  it("withhold refunds from the roles that should not have them", () => {
    // The audit found any signed-in user could refund a card. These three are
    // the roles most likely to be held by someone on the floor.
    for (const role of ["DESIGNER", "REGISTER", "WAREHOUSE"]) {
      expect(permissionsForBuiltInRole(role)).not.toContain("payment.refund");
    }
    expect(permissionsForBuiltInRole("MANAGER")).toContain("payment.refund");
  });

  it("withhold discounting and pricing from DESIGNER by default", () => {
    // Deliberate default, not a claim about this business: a deployment that
    // wants designers to discount grants it, and that grant is then visible.
    const designer = permissionsForBuiltInRole("DESIGNER");
    expect(designer).toContain("sales.write");
    expect(designer).not.toContain("sales.discount");
    expect(designer).not.toContain("catalog.pricing");
  });

  it("rank only the roles that form a privilege ladder", () => {
    // Lateral roles are different jobs, not rungs; ranking them would make
    // impersonating between them look like escalation.
    const ranked = BUILT_IN_ROLES.filter((r) => r.rank !== undefined).map((r) => r.key);
    expect(ranked.sort()).toEqual(["ADMIN", "MANAGER", "SUPER_ADMIN"]);
  });

  it("give store and stock-location setup to exactly the roles that could do it before its key", () => {
    // SEC-15: stock-location edit/delete was "Adjust inventory", and store
    // writes needed "Transfer stock" with a MANAGER/ADMIN staff role. The
    // switch starts on for that audience; WAREHOUSE views locations only.
    const holders = (key: string) =>
      BUILT_IN_ROLES.map((r) => r.key).filter((r) => {
        const g = permissionsForBuiltInRole(r);
        return g.includes("*") || g.includes(key);
      });
    expect(holders("inventory.locations.manage")).toEqual(holders("inventory.adjust"));
    expect(holders("inventory.locations.manage")).not.toContain("WAREHOUSE");
    expect(PERMISSIONS.find((p) => p.key === "inventory.locations.manage")?.sensitive).toBeFalsy();
  });

  it("give View cost to exactly the 12 roles that see cost today, the same rule the migration applies", () => {
    // SEC-14: "View cost" starts on for every built-in role that reaches cost on
    // some screen today (computed path by path in PLAN.md Appendix A), so
    // nothing changes until the owner unticks it. Migration 20261001120000
    // grants it to edited and custom roles by this same rule; the two must
    // agree or a database seeded from the lists and one migrated from older
    // grants would differ.
    const grants = (r: string) => permissionsForBuiltInRole(r);
    const wildcard = (r: string) => BUILT_IN_ROLES.find((b) => b.key === r)?.permissions === "*";
    const holds = (r: string, key: string) => wildcard(r) || grants(r).includes(key);
    const keys = BUILT_IN_ROLES.map((r) => r.key);

    const holders = keys.filter((r) => holds(r, "catalog.cost"));
    expect(holders.sort()).toEqual(
      [
        "ADMIN",
        "BUYER",
        "DATA_ENTRY",
        "DEPARTMENT_HEAD",
        "DESIGNER",
        "GENERAL_MANAGER",
        "HR",
        "MANAGER",
        "MARKETING",
        "REGISTER",
        "SUPER_ADMIN",
        "WAREHOUSE",
      ].sort(),
    );

    // The migration's WHERE clause, over the lists as they stood before the key.
    const migrationRule = (r: string) =>
      wildcard(r) ||
      ["ADMIN", "MANAGER"].includes(r) ||
      ["catalog.read", "catalog.write", "inventory.read", "reporting.read", "admin.settings"].some(
        (k) => holds(r, k),
      ) ||
      (r === "WAREHOUSE" && ["purchasing.read", "purchasing.receive"].some((k) => holds(r, k))) ||
      (holds(r, "accounting.read") && holds(r, "purchasing.write"));
    expect(keys.filter(migrationRule).sort()).toEqual(holders.sort());

    expect(PERMISSIONS.find((p) => p.key === "catalog.cost")?.sensitive).toBeFalsy();
  });
});
