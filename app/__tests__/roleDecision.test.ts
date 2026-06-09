// /app/__tests__/roleDecision.test.ts

import { decideRoleAccess } from "@/lib/auth/roleDecision";

describe("decideRoleAccess", () => {
  test("allows when the real role is directly in the allowed list", () => {
    const d = decideRoleAccess({
      allowedRoles: ["MANAGER", "ADMIN"],
      realRole: "MANAGER",
      impersonate: null,
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
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(false);
  });

  test("ignores impersonation for a non-privileged real role", () => {
    // A DESIGNER cannot impersonate ADMIN to gain access.
    const d = decideRoleAccess({
      allowedRoles: ["ADMIN"],
      realRole: "DESIGNER",
      impersonate: "ADMIN",
      privilegedCount: 5,
    });
    expect(d.effectiveUserRole).toBe("DESIGNER");
    expect(d.allowed).toBe(false);
  });

  test("impersonating UP from ADMIN to a matching gate is allowed", () => {
    const d = decideRoleAccess({
      allowedRoles: ["WAREHOUSE"],
      realRole: "ADMIN",
      impersonate: "WAREHOUSE",
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
      privilegedCount: 5,
    });
    expect(d.allowed).toBe(false);
  });
});
