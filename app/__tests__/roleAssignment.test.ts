// /app/__tests__/roleAssignment.test.ts
//
// The pure half of USE-02's assignment rule (lib/auth/roleAssignment.ts), and
// the two powers it also decides: setting a member's password and editing what
// a role can do. The routes and the database are covered in
// integration/staffRoleAssignment.integration.test.ts and
// integration/ownerTierEscalation.integration.test.ts.

import {
  legacyRoleFor,
  ownerOnlyKeysChanged,
  passwordRefusalFor,
  refusalFor,
  roleEditRefusalFor,
} from "@/lib/auth/roleAssignment";

const role = (over: Partial<Parameters<typeof refusalFor>[1]> = {}) => ({
  id: 1,
  key: "MANAGER",
  name: "Manager",
  isSystem: true,
  grantsAllPermissions: false,
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
