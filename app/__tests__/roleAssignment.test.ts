// /app/__tests__/roleAssignment.test.ts
//
// The pure half of USE-02's assignment rule (lib/auth/roleAssignment.ts). The
// routes, the database and the permission gate are covered in
// integration/staffRoleAssignment.integration.test.ts.

import { legacyRoleFor, refusalFor } from "@/lib/auth/roleAssignment";

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
