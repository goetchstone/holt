// /app/__tests__/permissionDecision.test.ts
//
// decidePermissionAccess is the capability-shaped sibling of decideRoleAccess.
// The point of these tests is NOT that "MANAGER can refund" -- that is the
// catalog's business, tested in permissionCatalog.test.ts. It is that the rules
// argued for in PR #67 and encoded in roleDecision.ts survive the move from
// role lists to capabilities:
//
//   - impersonation is honoured only for a real SUPER_ADMIN/ADMIN;
//   - impersonation only ever REDUCES privilege;
//   - the bootstrap safeguard still fires when no privileged user exists;
//   - the wildcard covers permissions that no RolePermission row mentions,
//     which is what makes a future release's new permission reach the Owner.

import {
  decidePermissionAccess,
  decideRoleAccess,
  resolveEffectiveRole,
} from "@/lib/auth/roleDecision";

const GRANTS = {
  SUPER_ADMIN: [] as string[], // wildcard holder — deliberately no rows
  ADMIN: ["payment.refund", "staff.manage"],
  MANAGER: ["payment.refund"],
  DESIGNER: ["sales.read"],
  FLOOR_LEAD: ["sales.discount"], // a deployment's own role
};

function decide(
  overrides: Partial<Parameters<typeof decidePermissionAccess>[0]> = {},
): ReturnType<typeof decidePermissionAccess> {
  return decidePermissionAccess({
    permission: "payment.refund",
    realRole: "MANAGER",
    impersonate: null,
    grantsByRole: GRANTS,
    wildcardRoles: ["SUPER_ADMIN"],
    privilegedCount: 5,
    ...overrides,
  });
}

describe("decidePermissionAccess — the capability check itself", () => {
  it("allows a role that holds the permission", () => {
    const d = decide();
    expect(d.allowed).toBe(true);
    expect(d.effectiveUserRole).toBe("MANAGER");
    expect(d.viaWildcard).toBe(false);
    expect(d.bootstrapBypass).toBe(false);
  });

  it("denies a role that does not hold it", () => {
    const d = decide({ realRole: "DESIGNER" });
    expect(d.allowed).toBe(false);
    expect(d.bootstrapBypass).toBe(false);
  });

  it("denies a role key nothing has ever heard of", () => {
    const d = decide({ realRole: "NOT_A_ROLE" });
    expect(d.allowed).toBe(false);
  });
});

describe("decidePermissionAccess — the wildcard", () => {
  it("holds a permission that appears in NO RolePermission row", () => {
    // This is the whole reason grantsAllPermissions is a boolean rather than 67
    // rows. `reticulation.splines` stands in for a permission a future release
    // adds: nothing has granted it to anybody, and the Owner still holds it.
    const d = decide({ realRole: "SUPER_ADMIN", permission: "reticulation.splines" });
    expect(d.allowed).toBe(true);
    expect(d.viaWildcard).toBe(true);
    // ...and it really is absent from every grant list in play.
    for (const grants of Object.values(GRANTS)) {
      expect(grants).not.toContain("reticulation.splines");
    }
  });

  it("does not leak to a non-wildcard role", () => {
    const d = decide({ realRole: "ADMIN", permission: "reticulation.splines" });
    expect(d.allowed).toBe(false);
  });
});

describe("decidePermissionAccess — impersonation cannot escalate", () => {
  it("an ADMIN impersonating SUPER_ADMIN does NOT gain owner-only capabilities", () => {
    // The exact regression PR #67 closed, restated for permissions:
    // admin.impersonate is the owner-only tier, and ADMIN is the one built-in
    // role that does not hold it.
    const d = decidePermissionAccess({
      permission: "admin.impersonate",
      realRole: "ADMIN",
      impersonate: "SUPER_ADMIN",
      grantsByRole: GRANTS,
      wildcardRoles: ["SUPER_ADMIN"],
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("ADMIN");
    expect(d.viaWildcard).toBe(false);
    expect(d.allowed).toBe(false);
  });

  it("an ADMIN impersonating SUPER_ADMIN does not pick up the wildcard for anything", () => {
    const d = decide({
      realRole: "ADMIN",
      impersonate: "SUPER_ADMIN",
      permission: "reticulation.splines",
    });
    expect(d.effectiveUserRole).toBe("ADMIN");
    expect(d.allowed).toBe(false);
  });

  it("honours a DOWNWARD impersonation — a SUPER_ADMIN viewing as DESIGNER cannot refund", () => {
    const d = decide({ realRole: "SUPER_ADMIN", impersonate: "DESIGNER" });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(false);
  });

  it("ignores the cookie entirely for a role that cannot impersonate", () => {
    const d = decide({ realRole: "DESIGNER", impersonate: "SUPER_ADMIN" });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(false);
  });

  it("treats lateral roles as freely impersonable — they are jobs, not rungs", () => {
    const d = decide({ realRole: "ADMIN", impersonate: "DESIGNER", permission: "sales.read" });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(true);
  });

  it("lets a deployment's own ranked role block escalation into it", () => {
    // Role.rank exists so a custom role participates in the anti-escalation
    // rule rather than silently ranking 0. Rank FLOOR_LEAD above ADMIN and an
    // ADMIN can no longer impersonate into it.
    const ranks = { MANAGER: 1, ADMIN: 2, SUPER_ADMIN: 3, FLOOR_LEAD: 9 };
    const d = decide({
      realRole: "ADMIN",
      impersonate: "FLOOR_LEAD",
      permission: "sales.discount",
      ranks,
    });
    expect(d.effectiveUserRole).toBe("ADMIN");
    expect(d.allowed).toBe(false);
  });

  it("still allows impersonating a custom role that ranks below", () => {
    const ranks = { MANAGER: 1, ADMIN: 2, SUPER_ADMIN: 3, FLOOR_LEAD: 1 };
    const d = decide({
      realRole: "ADMIN",
      impersonate: "FLOOR_LEAD",
      permission: "sales.discount",
      ranks,
    });
    expect(d.effectiveUserRole).toBe("FLOOR_LEAD");
    expect(d.allowed).toBe(true);
  });
});

describe("decidePermissionAccess — bootstrap safeguard", () => {
  it("grants a denied check while no privileged user exists yet", () => {
    const d = decide({ realRole: "DESIGNER", privilegedCount: 0 });
    expect(d.allowed).toBe(true);
    expect(d.bootstrapBypass).toBe(true);
  });

  it("stops granting the moment one privileged user exists", () => {
    const d = decide({ realRole: "DESIGNER", privilegedCount: 1 });
    expect(d.allowed).toBe(false);
    expect(d.bootstrapBypass).toBe(false);
  });

  it("never reports a bypass on a check that passed on its own merits", () => {
    const d = decide({ realRole: "MANAGER", privilegedCount: 0 });
    expect(d.allowed).toBe(true);
    expect(d.bootstrapBypass).toBe(false);
  });
});

describe("one implementation of the shared rules", () => {
  // The role path and the permission path must not merely agree today; they
  // must be incapable of disagreeing. Both call resolveEffectiveRole.
  it.each([
    ["ADMIN", "SUPER_ADMIN", "ADMIN"],
    ["SUPER_ADMIN", "DESIGNER", "DESIGNER"],
    ["DESIGNER", "ADMIN", "DESIGNER"],
    ["ADMIN", null, "ADMIN"],
  ])("resolveEffectiveRole(%s, %s) === %s on both paths", (real, imp, expected) => {
    expect(resolveEffectiveRole(real, imp as string | null)).toBe(expected);
    expect(
      decideRoleAccess({
        allowedRoles: [],
        realRole: real,
        impersonate: imp as string | null,
        privilegedCount: 1,
      }).effectiveUserRole,
    ).toBe(expected);
    expect(decide({ realRole: real, impersonate: imp as string | null }).effectiveUserRole).toBe(
      expected,
    );
  });
});
