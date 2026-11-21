// /app/__tests__/integration/roleListKeysMigration.integration.test.ts
//
// Migration 20261121120000, the role-list sweep (2026-11-21). Eleven new keys
// replaced hardcoded lists of staff enum roles, and Manager gained "Post
// journals" (accounting.post). The deploy seeder gives them to built-in roles
// nobody has edited; it never touches an edited built-in (grantsCustomized) or
// a role the store built, so this migration grants them there, to exactly the
// roles each old list let through. It also grants "Manage client books"
// (sales.clients.manage), which the Pipeline's manager checks now ask for, to
// edited Managers and Administrators: the key entered the catalog in #96 with
// no migration, so a role edited before then never had it. Real database, real
// seeder, the migration file itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../prisma/migrations/20261121120000_grant_role_list_keys/migration.sql"),
  "utf8",
);

/**
 * What the migration grants each edited built-in role. Written out rather than
 * derived from BUILT_IN_ROLES: a migration is fixed once it has run, and the
 * catalog may move on. permissionCatalog.test.ts pins the catalog's side.
 */
const EDITED_BUILT_INS: Record<string, string[]> = {
  ADMIN: [
    "accounting.chart.manage",
    "accounting.invoice",
    "customer.address",
    "customer.trade",
    "customer.wealth",
    "marketing.lists",
    "payment.return-refund",
    "reporting.financial",
    "reporting.management",
    // Not new (#96): the Pipeline's MANAGER/ADMIN checks moved onto it.
    "sales.clients.manage",
    "sales.proposal",
    "service.setup",
  ],
  MANAGER: [
    "accounting.chart.manage",
    "accounting.invoice",
    "accounting.post",
    "customer.address",
    "customer.trade",
    "payment.return-refund",
    "reporting.management",
    "sales.clients.manage",
    "sales.proposal",
    "service.setup",
  ],
  DESIGNER: ["customer.address"],
  REGISTER: ["payment.return-refund"],
  WAREHOUSE: ["customer.address", "payment.return-refund"],
  MARKETING: ["customer.address", "customer.wealth", "marketing.lists"],
  // Passed none of the lists, the Pipeline's included, though it holds Manage
  // client books by default.
  GENERAL_MANAGER: [],
};

/** Every role's stored grants, by role key, sorted. */
async function grantsByRole(): Promise<Map<string, string[]>> {
  const roles = await prisma.role.findMany({
    select: { key: true, permissions: { select: { permission: true } } },
  });
  return new Map(roles.map((r) => [r.key, r.permissions.map((p) => p.permission).sort()]));
}

async function allGrantRows() {
  return prisma.rolePermission.findMany({
    select: { id: true, roleId: true, permission: true },
    orderBy: { id: "asc" },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("migration 20261121120000 grants the role-list keys where the seeder never reaches", () => {
  it("gives each edited built-in its old lists' keys and custom roles the address key, once", async () => {
    // An owner edited these built-ins before the keys existed, so the seeder
    // leaves their grants alone. Emptied, so what the migration adds is all
    // they hold afterwards.
    for (const key of Object.keys(EDITED_BUILT_INS)) {
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    }
    // Two roles of the store's own, whose staff carry the enum DESIGNER: an
    // ordinary one with a grant of its own, and one that grants every key.
    await prisma.role.create({
      data: {
        key: "FLOOR_LEAD",
        name: "Floor Lead",
        isSystem: false,
        permissions: { create: [{ permission: "sales.read" }] },
      },
    });
    await prisma.role.create({
      data: {
        key: "OWNERS_CIRCLE",
        name: "Owners' circle",
        isSystem: false,
        grantsAllPermissions: true,
      },
    });
    const before = await grantsByRole();

    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    const afterFirstRun = await allGrantRows();
    await prisma.$executeRawUnsafe(MIGRATION_SQL);

    // Idempotent: the second run writes nothing, so the rows and their ids match.
    expect(await allGrantRows()).toEqual(afterFirstRun);

    // What it added, role by role. Every role not named here gets nothing: the
    // wildcard SUPER_ADMIN and OWNERS_CIRCLE, which hold every key with no rows,
    // and the unedited built-ins none of the lists named (they already hold
    // what their BUILT_IN_ROLES lists give them, from the seeder).
    const expected: Record<string, string[]> = {
      ...EDITED_BUILT_INS,
      // The address list named DESIGNER, the enum a custom role's staff carry.
      FLOOR_LEAD: ["customer.address"],
    };
    const after = await grantsByRole();
    const added = Object.fromEntries(
      [...after].map(([key, grants]) => [
        key,
        grants.filter((g) => !(before.get(key) ?? []).includes(g)),
      ]),
    );
    expect(added).toEqual(
      Object.fromEntries([...after.keys()].map((key) => [key, [...(expected[key] ?? [])].sort()])),
    );
    // The wildcard roles store no rows at all.
    expect(after.get("SUPER_ADMIN")).toEqual([]);
    expect(after.get("OWNERS_CIRCLE")).toEqual([]);

    // A grant a role already held is left alone.
    for (const [key, grants] of before) {
      expect({ key, grants: after.get(key) }).toEqual({
        key,
        grants: expect.arrayContaining(grants),
      });
    }
  });
});
