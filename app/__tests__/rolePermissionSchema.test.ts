// /app/__tests__/rolePermissionSchema.test.ts
//
// Tripwire for the equality the whole RBAC foundation is balanced on: the eight
// BUILT_IN_ROLES keys and the eight StaffRole enum values are THE SAME SET.
//
// Two things break silently if that ever stops being true:
//   - the roleId backfill in migration 20260806160000_role_and_role_permission
//     joins Role.key = StaffMember.role::text. An enum value with no matching
//     role leaves that staff member unlinked -- the migration RAISEs on it, so
//     a deploy would fail rather than corrupt, but only after it had already
//     started;
//   - requirePermission's enum fallback resolves an unlinked staff member
//     through permissionsForBuiltInRole(staff.role). A role key with no
//     built-in definition resolves to [] -- no permissions at all -- and
//     someone is locked out of their own job with nothing in the logs to say
//     why.
//
// Source-text scan of schema.prisma rather than a behavioural assertion,
// because the thing under test is a correspondence between a Prisma enum
// declaration and a TypeScript array. There is no runtime at which they are
// both values (CLAUDE.md rule 57: tripwires are for "these must stay in sync"
// invariants; this is one).

import { readFileSync } from "fs";
import { join } from "path";

import { BUILT_IN_ROLES, isPermissionKey, permissionsForBuiltInRole } from "@/lib/auth/permissionCatalog";

const SCHEMA = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
const MIGRATION = readFileSync(
  join(__dirname, "..", "prisma", "migrations", "20260806160000_role_and_role_permission", "migration.sql"),
  "utf8",
);

function parseStaffRoleEnum(): string[] {
  const block = SCHEMA.match(/^enum\s+StaffRole\s*\{([^}]*)\}/m);
  if (!block) throw new Error("StaffRole enum not found in schema.prisma");
  return block[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => l.length > 0)
    .sort();
}

describe("StaffRole enum <-> BUILT_IN_ROLES", () => {
  const enumValues = parseStaffRoleEnum();
  const roleKeys = BUILT_IN_ROLES.map((r) => r.key).sort();

  it("every StaffRole enum value has a built-in role definition", () => {
    const missing = enumValues.filter((v) => !roleKeys.includes(v));
    expect(missing).toEqual([]);
  });

  it("every built-in role key is a StaffRole enum value", () => {
    const extra = roleKeys.filter((k) => !enumValues.includes(k));
    expect(extra).toEqual([]);
  });

  it("the two sets are identical, in both directions, with no duplicates", () => {
    expect(roleKeys).toEqual(enumValues);
    expect(new Set(roleKeys).size).toBe(roleKeys.length);
    expect(new Set(enumValues).size).toBe(enumValues.length);
  });
});

describe("built-in role grants name real permissions", () => {
  it("every key in every built-in role's grants exists in PERMISSIONS", () => {
    // A grant naming a permission the catalog no longer declares authorizes
    // nothing while still reading as a grant. Checked here for the code-side
    // definitions; findOrphanPermissionKeys() is the same check for rows
    // already in the database.
    const bad: { role: string; key: string }[] = [];
    for (const role of BUILT_IN_ROLES) {
      for (const key of permissionsForBuiltInRole(role.key)) {
        if (!isPermissionKey(key)) bad.push({ role: role.key, key });
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the roleId backfill migration", () => {
  // Integration tests build their schema with `prisma db push`, never
  // `migrate deploy`, so nothing else in the suite executes this file. The
  // backfill is the entire reason day one is a no-op; losing it silently is
  // exactly the failure this scan is cheap insurance against.

  it("links every StaffMember to the Role whose key equals their StaffRole", () => {
    expect(MIGRATION).toMatch(/UPDATE "StaffMember"[\s\S]*SET "roleId" = r\."id"/);
    expect(MIGRATION).toMatch(/r\."key" = s\."role"::text/);
  });

  it("refuses to complete with an unlinked StaffMember", () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'roleId backfill left/);
  });

  it("gives the wildcard role a flag and no RolePermission rows", () => {
    // Materialising "*" as rows would freeze the Owner's grants at seeding
    // time. If a future edit adds SUPER_ADMIN rows to this migration, the
    // wildcard has quietly stopped being the mechanism.
    expect(MIGRATION).toMatch(/\('SUPER_ADMIN', 'Owner',[^\n]*true, true, 3\)/);
    expect(MIGRATION).not.toMatch(/\('SUPER_ADMIN', '[a-z]+\./);
  });
});
