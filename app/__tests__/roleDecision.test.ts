// /app/__tests__/roleDecision.test.ts

import {
  BUILT_IN_ROLES,
  OWNER_ONLY_PERMISSIONS,
  permissionsForBuiltInRole,
} from "@/lib/auth/permissionCatalog";
import { decideRoleAccess, IMPERSONATE, mayImpersonate } from "@/lib/auth/roleDecision";

/** mayImpersonate's answer for a built-in role's default grants. */
const builtInMayImpersonate = (role: string) =>
  mayImpersonate((key) => permissionsForBuiltInRole(role).includes(key));

describe("who may View as (IMPERSONATE)", () => {
  test("is decided on keys: Impersonate or Change settings, either one", () => {
    expect(IMPERSONATE).toEqual({ anyOf: ["admin.impersonate", "admin.settings"] });
    expect(mayImpersonate((key) => key === "admin.impersonate")).toBe(true);
    expect(mayImpersonate((key) => key === "admin.settings")).toBe(true);
    expect(mayImpersonate((key) => key === "staff.manage")).toBe(false);
    expect(mayImpersonate(() => false)).toBe(false);
  });

  test("keeps today's built-in audience: the Owner and the Administrator, no one else", () => {
    // Role names used to decide this (useEffectiveRole.ts and roleDecision.ts).
    // Moving it to keys must not hand View as to any other built-in role.
    const audience = BUILT_IN_ROLES.map((r) => r.key).filter(builtInMayImpersonate);
    expect(audience.sort()).toEqual(["ADMIN", "SUPER_ADMIN"]);
    // The Administrator gets it through Change settings, not the owner-tier key.
    expect(OWNER_ONLY_PERMISSIONS).toContain("admin.impersonate");
    expect(permissionsForBuiltInRole("ADMIN")).not.toContain("admin.impersonate");
  });
});

describe("decideRoleAccess", () => {
  test("allows when the real role is directly in the allowed list", () => {
    const d = decideRoleAccess({
      allowedRoles: ["MANAGER", "ADMIN"],
      realRole: "MANAGER",
      impersonate: null,
      canImpersonate: false,
      privilegedCount: 5,
    });
    expect(d.allowed).toBe(true);
    expect(d.effectiveUserRole).toBe("MANAGER");
    expect(d.bootstrapBypass).toBe(false);
  });

  test("denies when the role is not allowed and privileged users exist", () => {
    const d = decideRoleAccess({
      allowedRoles: ["ADMIN"],
      realRole: "DESIGNER",
      impersonate: null,
      canImpersonate: false,
      privilegedCount: 3,
    });
    expect(d.allowed).toBe(false);
    expect(d.bootstrapBypass).toBe(false);
  });

  test("SUPER_ADMIN satisfies an ADMIN-only gate without being named", () => {
    const d = decideRoleAccess({
      allowedRoles: ["ADMIN"],
      realRole: "SUPER_ADMIN",
      impersonate: null,
      canImpersonate: true,
      privilegedCount: 5,
    });
    expect(d.allowed).toBe(true);
    expect(d.effectiveUserRole).toBe("SUPER_ADMIN");
  });

  test("honors impersonation for a real ADMIN (downgrade to DESIGNER view denies admin gate)", () => {
    const d = decideRoleAccess({
      allowedRoles: ["ADMIN"],
      realRole: "ADMIN",
      impersonate: "DESIGNER",
      canImpersonate: true,
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(false);
  });

  test("ignores impersonation for a role that may not View as", () => {
    // A DESIGNER cannot impersonate ADMIN to gain access.
    const d = decideRoleAccess({
      allowedRoles: ["ADMIN"],
      realRole: "DESIGNER",
      impersonate: "ADMIN",
      canImpersonate: false,
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(false);
  });

  test("ignores the cookie for an ADMIN whose role holds neither View-as key", () => {
    // The owner unticked Change settings on Administrator: the cookie no longer
    // changes what that admin's checks run as.
    const d = decideRoleAccess({
      allowedRoles: ["WAREHOUSE", "ADMIN"],
      realRole: "ADMIN",
      impersonate: "WAREHOUSE",
      canImpersonate: false,
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("ADMIN");
    expect(d.allowed).toBe(true);
  });

  test("viewing as a role that passes, from a real role that passes too, is allowed", () => {
    const d = decideRoleAccess({
      allowedRoles: ["WAREHOUSE", "ADMIN"],
      realRole: "ADMIN",
      impersonate: "WAREHOUSE",
      canImpersonate: true,
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("WAREHOUSE");
    expect(d.allowed).toBe(true);
  });

  test("bootstrap bypass: grants access when no privileged user exists yet", () => {
    const d = decideRoleAccess({
      allowedRoles: ["ADMIN"],
      realRole: "DESIGNER",
      impersonate: null,
      canImpersonate: false,
      privilegedCount: 0,
    });
    expect(d.allowed).toBe(true);
    expect(d.bootstrapBypass).toBe(true);
  });

  test("no bootstrap bypass needed when role already allowed (flag stays false)", () => {
    const d = decideRoleAccess({
      allowedRoles: ["DESIGNER"],
      realRole: "DESIGNER",
      impersonate: null,
      canImpersonate: false,
      privilegedCount: 0,
    });
    expect(d.allowed).toBe(true);
    expect(d.bootstrapBypass).toBe(false);
  });

  test("explicit SUPER_ADMIN-only gate is not satisfied by ADMIN", () => {
    const d = decideRoleAccess({
      allowedRoles: ["SUPER_ADMIN"],
      realRole: "ADMIN",
      impersonate: null,
      canImpersonate: true,
      privilegedCount: 5,
    });
    expect(d.allowed).toBe(false);
  });

  describe("impersonation cannot escalate", () => {
    test("ADMIN impersonating SUPER_ADMIN does not satisfy a SUPER_ADMIN gate", () => {
      // The whole point of a tier above ADMIN is that ADMIN cannot reach it.
      // Honouring the cookie verbatim made holt-impersonate a self-serve
      // privilege upgrade for anyone already holding ADMIN.
      const d = decideRoleAccess({
        allowedRoles: ["SUPER_ADMIN"],
        realRole: "ADMIN",
        impersonate: "SUPER_ADMIN",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(false);
      expect(d.effectiveUserRole).toBe("ADMIN");
    });

    test("MANAGER's impersonation is ignored entirely, escalating or not", () => {
      const d = decideRoleAccess({
        allowedRoles: ["ADMIN"],
        realRole: "MANAGER",
        impersonate: "ADMIN",
        canImpersonate: builtInMayImpersonate("MANAGER"),
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(false);
      expect(d.effectiveUserRole).toBe("MANAGER");
    });

    test("SUPER_ADMIN impersonating ADMIN still works — downward is the point", () => {
      const d = decideRoleAccess({
        allowedRoles: ["ADMIN"],
        realRole: "SUPER_ADMIN",
        impersonate: "ADMIN",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(true);
      expect(d.effectiveUserRole).toBe("ADMIN");
    });

    test("SUPER_ADMIN impersonating DESIGNER loses SUPER_ADMIN's reach", () => {
      // Seeing the app as a designer has to mean actually being limited to
      // what a designer can do, or impersonation proves nothing.
      const d = decideRoleAccess({
        allowedRoles: ["ADMIN"],
        realRole: "SUPER_ADMIN",
        impersonate: "DESIGNER",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(false);
      expect(d.effectiveUserRole).toBe("DESIGNER");
    });

    test("ADMIN impersonating a lateral role is honoured — those are not rungs", () => {
      const d = decideRoleAccess({
        allowedRoles: ["WAREHOUSE", "ADMIN"],
        realRole: "ADMIN",
        impersonate: "WAREHOUSE",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(true);
      expect(d.effectiveUserRole).toBe("WAREHOUSE");
    });

    test("ADMIN impersonating MANAGER is a downgrade and is honoured", () => {
      const d = decideRoleAccess({
        allowedRoles: ["ADMIN"],
        realRole: "ADMIN",
        impersonate: "MANAGER",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(false);
      expect(d.effectiveUserRole).toBe("MANAGER");
    });
  });

  describe("View as only narrows: the real role must pass the list too", () => {
    // Until View as moved to keys this passed: a list only the viewed role
    // matched admitted an ADMIN viewing as that role. Once a store's own role
    // holding Change settings may View as (its staff carry the enum DESIGNER),
    // the same rule would let it pass any list by viewing as a role on it.
    test("an ADMIN viewing as WAREHOUSE does not pass a WAREHOUSE-only list", () => {
      const d = decideRoleAccess({
        allowedRoles: ["WAREHOUSE"],
        realRole: "ADMIN",
        impersonate: "WAREHOUSE",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.effectiveUserRole).toBe("WAREHOUSE");
      expect(d.allowed).toBe(false);
      expect(d.bootstrapBypass).toBe(false);
    });

    test("a store's own role that may View as cannot borrow a list it is not on", () => {
      // Custom-role staff carry the enum DESIGNER.
      const borrow = (allowedRoles: string[]) =>
        decideRoleAccess({
          allowedRoles,
          realRole: "DESIGNER",
          impersonate: "WAREHOUSE",
          canImpersonate: true,
          privilegedCount: 5,
        });
      expect(borrow(["MANAGER", "ADMIN", "WAREHOUSE"]).allowed).toBe(false);
      // On a list naming both, viewing as WAREHOUSE narrows to WAREHOUSE.
      const both = borrow(["DESIGNER", "WAREHOUSE"]);
      expect(both.allowed).toBe(true);
      expect(both.effectiveUserRole).toBe("WAREHOUSE");
    });

    test("the Owner viewing as ADMIN passes an ADMIN list: SUPER_ADMIN is on it by the ADMIN rule", () => {
      const d = decideRoleAccess({
        allowedRoles: ["MANAGER", "ADMIN", "DESIGNER"],
        realRole: "SUPER_ADMIN",
        impersonate: "ADMIN",
        canImpersonate: true,
        privilegedCount: 5,
      });
      expect(d.allowed).toBe(true);
      expect(d.effectiveUserRole).toBe("ADMIN");
    });
  });
});
