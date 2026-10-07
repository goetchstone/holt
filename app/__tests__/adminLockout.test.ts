// /app/__tests__/adminLockout.test.ts
//
// SEC-03: the pure decision behind the last-admin guard. wouldRemoveLastAdmin
// does the DB reads (proven against a real database in
// __tests__/integration/staffLastOwner.integration.test.ts); this pins the
// arithmetic, both directions.

import { isPrivilegedStaffRole, removesLastAdmin } from "@/lib/auth/adminLockout";

describe("removesLastAdmin", () => {
  it("is true only when the target is an active admin and no other active admin remains", () => {
    expect(removesLastAdmin({ targetActivePrivileged: true, otherActiveAdmins: 0 })).toBe(true);
  });

  it("is false when another active admin remains", () => {
    expect(removesLastAdmin({ targetActivePrivileged: true, otherActiveAdmins: 1 })).toBe(false);
    expect(removesLastAdmin({ targetActivePrivileged: true, otherActiveAdmins: 5 })).toBe(false);
  });

  it("is false when the target is not an active admin (nothing to lose)", () => {
    expect(removesLastAdmin({ targetActivePrivileged: false, otherActiveAdmins: 0 })).toBe(false);
  });
});

describe("isPrivilegedStaffRole", () => {
  it.each([
    ["ADMIN", true],
    ["SUPER_ADMIN", true],
    ["MANAGER", false],
    ["GENERAL_MANAGER", false],
    ["HR", false],
    ["DESIGNER", false],
    [null, false],
    [undefined, false],
  ] as const)("%s -> %s", (role, expected) => {
    expect(isPrivilegedStaffRole(role)).toBe(expected);
  });
});
