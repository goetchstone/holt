// /app/__tests__/roleAssignment.test.ts
//
// The pure half of USE-02's assignment rule (lib/auth/roleAssignment.ts), and
// the two powers it also decides: setting a member's password and editing what
// a role can do. The routes and the database are covered in
// integration/staffRoleAssignment.integration.test.ts and
// integration/ownerTierEscalation.integration.test.ts.

import {
  deactivationRefusalFor,
  isOwnerTierMember,
  legacyRoleFor,
  normalizeStaffEmail,
  ownerOnlyKeysChanged,
  passwordRefusalFor,
  refusalFor,
  roleEditRefusalFor,
  signInChanges,
  signInRefusalFor,
  signInSubjectFor,
  type SignInChange,
} from "@/lib/auth/roleAssignment";

const role = (over: Partial<Parameters<typeof refusalFor>[1]> = {}) => ({
  id: 1,
  key: "MANAGER",
  name: "Manager",
  isSystem: true,
  grantsAllPermissions: false,
  ownerOnlyKeys: [] as readonly string[],
  ...over,
});

describe("legacyRoleFor", () => {
  it("writes a built-in role's own key", () => {
    expect(legacyRoleFor({ key: "MANAGER", isSystem: true })).toBe("MANAGER");
    expect(legacyRoleFor({ key: "SUPER_ADMIN", isSystem: true })).toBe("SUPER_ADMIN");
  });

  it("writes the least-privileged enum for a custom role (owner, 2026-09-23)", () => {
    expect(legacyRoleFor({ key: "FLOOR_LEAD", isSystem: false })).toBe("DESIGNER");
    // A custom role whose key happens to spell a built-in is still custom.
    expect(legacyRoleFor({ key: "ADMIN", isSystem: false })).toBe("DESIGNER");
  });
});

describe("refusalFor", () => {
  it("lets an ADMIN or SUPER_ADMIN assign an ordinary role", () => {
    expect(refusalFor("ADMIN", role())).toBeNull();
    expect(refusalFor("SUPER_ADMIN", role())).toBeNull();
  });

  it("refuses anyone else, including staff managers and unknown callers", () => {
    for (const caller of ["HR", "GENERAL_MANAGER", "MANAGER", "DESIGNER", null]) {
      expect(refusalFor(caller, role())).toMatch(/only an admin/i);
    }
  });

  it("keeps the owner tier for owners", () => {
    const owner = role({ key: "SUPER_ADMIN", name: "Owner", grantsAllPermissions: true });
    const allOfIt = role({
      key: "EVERYTHING",
      name: "Everything",
      isSystem: false,
      grantsAllPermissions: true,
    });
    expect(refusalFor("ADMIN", owner)).toMatch(/only an owner/i);
    expect(refusalFor("ADMIN", allOfIt)).toMatch(/only an owner/i);
    expect(refusalFor("SUPER_ADMIN", owner)).toBeNull();
    expect(refusalFor("SUPER_ADMIN", allOfIt)).toBeNull();
  });

  it("counts a role holding an owner-only key as the owner tier (assigning it hands over the key)", () => {
    const payroll = role({
      key: "PAYROLL",
      name: "Payroll",
      isSystem: false,
      ownerOnlyKeys: ["staff.commission-pay"],
    });
    expect(refusalFor("ADMIN", payroll)).toBe("Only an owner can assign Payroll.");
    expect(refusalFor("SUPER_ADMIN", payroll)).toBeNull();
  });
});

describe("passwordRefusalFor: setting a password is assigning a role", () => {
  it("lets an admin set an ordinary member's password", () => {
    expect(passwordRefusalFor("ADMIN", role())).toBeNull();
    expect(
      passwordRefusalFor("SUPER_ADMIN", role({ key: "ADMIN", name: "Administrator" })),
    ).toBeNull();
  });

  it("refuses staff managers: General Manager and People Operations hold staff.manage", () => {
    for (const caller of ["HR", "GENERAL_MANAGER", "MANAGER", "DESIGNER", null]) {
      expect(passwordRefusalFor(caller, role())).toMatch(/only an admin/i);
    }
  });

  it("keeps the owner tier's passwords for owners", () => {
    const owner = role({ key: "SUPER_ADMIN", name: "Owner", grantsAllPermissions: true });
    const wildcard = role({
      key: "PARTNER",
      name: "Partner",
      isSystem: false,
      grantsAllPermissions: true,
    });
    expect(passwordRefusalFor("ADMIN", owner)).toMatch(/only an owner/i);
    expect(passwordRefusalFor("ADMIN", wildcard)).toMatch(/only an owner/i);
    expect(passwordRefusalFor("SUPER_ADMIN", owner)).toBeNull();
  });
});

describe("roleEditRefusalFor and ownerOnlyKeysChanged", () => {
  it("lets an admin edit a role when no owner-only key moves", () => {
    expect(roleEditRefusalFor("ADMIN", [])).toBeNull();
    expect(roleEditRefusalFor("SUPER_ADMIN", [])).toBeNull();
  });

  it("refuses staff managers outright, whatever the edit", () => {
    for (const caller of ["HR", "GENERAL_MANAGER", "MANAGER", null]) {
      expect(roleEditRefusalFor(caller, [])).toMatch(/only an admin/i);
    }
  });

  it("names the owner-only keys an admin tried to move, and lets an owner move them", () => {
    expect(roleEditRefusalFor("ADMIN", ["staff.commission-pay"])).toMatch(
      /only an owner can grant or revoke ".+"/i,
    );
    expect(
      roleEditRefusalFor("SUPER_ADMIN", ["staff.commission-pay", "admin.impersonate"]),
    ).toBeNull();
  });

  it("counts an owner-only key as changed only when it is added or removed", () => {
    expect(ownerOnlyKeysChanged(["sales.read"], ["sales.read", "staff.commission-pay"])).toEqual([
      "staff.commission-pay",
    ]);
    expect(ownerOnlyKeysChanged(["admin.impersonate"], [])).toEqual(["admin.impersonate"]);
    // Kept on a role while other grants change: nothing owner-only moved.
    expect(
      ownerOnlyKeysChanged(["staff.commission-pay"], ["staff.commission-pay", "sales.read"]),
    ).toEqual([]);
    expect(ownerOnlyKeysChanged(["admin.settings"], ["admin.settings", "admin.config"])).toEqual(
      [],
    );
  });
});

const CALLERS = [null, "DESIGNER", "GENERAL_MANAGER", "HR", "MANAGER", "ADMIN", "SUPER_ADMIN"];
const CHANGES: SignInChange[] = ["password", "sign-in email", "active status", "login link", "role"];

/** The refusal signInRefusalFor must give, written out rather than derived. */
function expectedSignInRefusal(caller: string | null, ownerTier: boolean, change: SignInChange) {
  const admin = caller === "ADMIN" || caller === "SUPER_ADMIN";
  if (!admin) {
    return change === "password"
      ? "Only an admin can set a staff member's password."
      : `Only an admin can change a staff member's ${change}.`;
  }
  if (ownerTier && caller !== "SUPER_ADMIN") {
    return change === "password"
      ? "Only an owner can set the password of someone who holds Owner."
      : `Only an owner can change the ${change} of someone who holds Owner.`;
  }
  return null;
}

describe("signInRefusalFor: changing how someone signs in is assigning their role", () => {
  for (const caller of CALLERS) {
    for (const ownerTier of [true, false]) {
      for (const change of CHANGES) {
        it(`${caller ?? "nobody"} / ${ownerTier ? "owner tier" : "ordinary"} / ${change}`, () => {
          expect(signInRefusalFor(caller, { roleName: "Owner", ownerTier }, change)).toBe(
            expectedSignInRefusal(caller, ownerTier, change),
          );
        });
      }
    }
  }

  it("leaves passwordRefusalFor's messages as they were", () => {
    const owner = role({ key: "SUPER_ADMIN", name: "Owner", grantsAllPermissions: true });
    expect(passwordRefusalFor("HR", role())).toBe("Only an admin can set a staff member's password.");
    expect(passwordRefusalFor("ADMIN", owner)).toBe(
      "Only an owner can set the password of someone who holds Owner.",
    );
  });
});

describe("deactivationRefusalFor: switching someone off is narrower", () => {
  const ordinary = { roleName: "Designer", privileged: false, ownerTierByRole: false };
  const administrator = { roleName: "Administrator", privileged: true, ownerTierByRole: false };
  const owner = { roleName: "Owner", privileged: true, ownerTierByRole: true };

  it("lets anyone who reaches it switch off an ordinary member", () => {
    for (const caller of CALLERS) expect(deactivationRefusalFor(caller, ordinary)).toBeNull();
  });

  it("keeps an Administrator for admins, and the owner tier for owners", () => {
    for (const caller of ["HR", "GENERAL_MANAGER", "MANAGER", "DESIGNER", null]) {
      expect(deactivationRefusalFor(caller, administrator)).toBe(
        "Only an admin can deactivate someone who holds Administrator.",
      );
      expect(deactivationRefusalFor(caller, owner)).toBe(
        "Only an owner can deactivate someone who holds Owner.",
      );
    }
    expect(deactivationRefusalFor("ADMIN", administrator)).toBeNull();
    expect(deactivationRefusalFor("ADMIN", owner)).toBe(
      "Only an owner can deactivate someone who holds Owner.",
    );
    expect(deactivationRefusalFor("SUPER_ADMIN", owner)).toBeNull();
  });
});

describe("isOwnerTierMember and signInSubjectFor: the member's tier, read strictly", () => {
  const designerRole = { key: "DESIGNER", name: "Designer", grantsAllPermissions: false };
  const wildcard = { key: "PARTNER", name: "Partner", grantsAllPermissions: true };
  const adminRole = { key: "ADMIN", name: "Administrator", grantsAllPermissions: false };

  it("is the owner tier when the enum, the Role row or an owner-only key says so", () => {
    expect(
      isOwnerTierMember({ enumRole: "SUPER_ADMIN", role: designerRole, ownerOnlyKeysHeld: [] }),
    ).toBe(true);
    expect(isOwnerTierMember({ enumRole: "ADMIN", role: wildcard, ownerOnlyKeysHeld: [] })).toBe(
      true,
    );
    expect(
      isOwnerTierMember({
        enumRole: "DESIGNER",
        role: { key: "PAYROLL", name: "Payroll", grantsAllPermissions: false },
        ownerOnlyKeysHeld: ["staff.commission-pay"],
      }),
    ).toBe(true);
    expect(isOwnerTierMember({ enumRole: "ADMIN", role: adminRole, ownerOnlyKeysHeld: [] })).toBe(
      false,
    );
    expect(isOwnerTierMember({ enumRole: "DESIGNER", role: null, ownerOnlyKeysHeld: [] })).toBe(
      false,
    );
  });

  it("does not let an owner-only key make deactivation owner-only", () => {
    const gmWithKey = signInSubjectFor({
      enumRole: "GENERAL_MANAGER",
      role: { key: "GENERAL_MANAGER", name: "General Manager", grantsAllPermissions: false },
      ownerOnlyKeysHeld: ["staff.commission-pay"],
    });
    expect(gmWithKey).toEqual({
      roleName: "General Manager",
      ownerTier: true,
      ownerTierByRole: false,
      privileged: false,
    });
  });

  it("calls a member privileged by either column", () => {
    const split = signInSubjectFor({ enumRole: "ADMIN", role: designerRole, ownerOnlyKeysHeld: [] });
    expect(split.privileged).toBe(true);
    const byRole = signInSubjectFor({ enumRole: "DESIGNER", role: adminRole, ownerOnlyKeysHeld: [] });
    expect(byRole.privileged).toBe(true);
    const enumOwner = signInSubjectFor({
      enumRole: "SUPER_ADMIN",
      role: designerRole,
      ownerOnlyKeysHeld: [],
    });
    expect(enumOwner).toMatchObject({ ownerTier: true, ownerTierByRole: true, privileged: true });
    const noRole = signInSubjectFor({ enumRole: "REGISTER", role: null, ownerOnlyKeysHeld: [] });
    expect(noRole).toEqual({
      roleName: "REGISTER",
      ownerTier: false,
      ownerTierByRole: false,
      privileged: false,
    });
  });
});

describe("signInChanges: what a PATCH body changes about signing in", () => {
  const current = { email: "sam@example.com", isActive: true };

  it("sees no change in a resent email, trimmed on both sides", () => {
    expect(signInChanges(current, { email: "sam@example.com" })).toEqual({});
    expect(signInChanges(current, { email: "  sam@example.com " })).toEqual({});
    expect(signInChanges({ ...current, email: " sam@example.com  " }, { email: "sam@example.com" }))
      .toEqual({});
    expect(signInChanges({ ...current, email: null }, { email: "" })).toEqual({});
    expect(signInChanges({ ...current, email: "   " }, { email: null })).toEqual({});
    expect(signInChanges(current, {})).toEqual({});
  });

  it("reports a changed or cleared email, trimmed, compared exactly", () => {
    expect(signInChanges(current, { email: " new@example.com " })).toEqual({
      email: "new@example.com",
    });
    expect(signInChanges(current, { email: "Sam@example.com" })).toEqual({
      email: "Sam@example.com",
    });
    expect(signInChanges(current, { email: null })).toEqual({ email: null });
  });

  it("reports switching off and back on, and nothing for the state it already has", () => {
    expect(signInChanges(current, { isActive: true })).toEqual({});
    expect(signInChanges(current, { isActive: false })).toEqual({ active: "deactivate" });
    expect(signInChanges({ ...current, isActive: false }, { isActive: true })).toEqual({
      active: "reactivate",
    });
  });

  it("normalizes an email the one way both sides use", () => {
    expect(normalizeStaffEmail("  a@b.c ")).toBe("a@b.c");
    expect(normalizeStaffEmail("")).toBeNull();
    expect(normalizeStaffEmail(null)).toBeNull();
    expect(normalizeStaffEmail(undefined)).toBeNull();
  });
});
