// /app/__tests__/integration/allSalespeopleGate.integration.test.ts
//
// "See every salesperson's numbers" (reporting.all-salespeople). Who may ask the
// Monthly Performance, Salesperson Detail and Designer Dashboard reports for
// someone else's numbers used to be a hardcoded set of staff enum roles in the
// reports router. It is now a permission a store sets per role in Roles, and
// the one-time migration keeps it on for an edited Manager or Administrator,
// which the deploy seeder never touches. Real router, real permission gate,
// real database; no mocks are needed beyond the caller's context.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";

const KEY = "reporting.all-salespeople";

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20261118120000_grant_reporting_all_salespeople/migration.sql",
  ),
  "utf8",
);

/** The reports router as a signed-in caller. `tokenRole` is the staff enum in
 *  the session token, which no longer decides anything here. */
function reportsAs(userId: string, tokenRole: string) {
  const ctx: TrpcContext = {
    userId,
    userEmail: `${userId}@example.com`,
    tokenRole,
    impersonate: null,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx).reports;
}

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

async function makeStaff(userId: string, roleKey: string) {
  await makeUser(userId);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: roleKey as any, roleId: role.id },
  });
}

async function customRole(key: string, permissions: string[]) {
  return prisma.role.create({
    data: {
      key,
      name: key,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
}

/** A staff member on a role of the store's own, with the enum the old check
 *  read set to `enumRole` (custom roles carry DESIGNER in real data). */
async function makeCustomRoleStaff(userId: string, permissions: string[], enumRole = "DESIGNER") {
  await makeUser(userId);
  const role = await customRole(`CUSTOM_${userId.toUpperCase()}`, permissions);
  // As the roles API does after a write: a grant table cached before this role
  // existed would not know its id and would fall back to the staff enum.
  invalidateRoleGrantCache();
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: enumRole as any, roleId: role.id },
  });
}

async function grants(roleKey: string): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { permissions: { select: { permission: true } } },
  });
  return role.permissions.map((p) => p.permission);
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
  // The salesperson the callers below ask about.
  await makeStaff("ana", "DESIGNER");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("who may pick a salesperson follows reporting.all-salespeople", () => {
  it("a holder gets the salesperson they asked for", async () => {
    await makeStaff("mia", "MANAGER");
    const data = await reportsAs("mia", "MANAGER").monthlyPerformance({ salesperson: "ana" });
    expect(data.salesperson).toBe("ana");
  });

  it("holding the key is what counts, not the staff enum in the token", async () => {
    // Enum DESIGNER (which the old check refused) on a role that holds the key.
    await makeCustomRoleStaff("hal", ["reporting.read", KEY]);
    const data = await reportsAs("hal", "DESIGNER").monthlyPerformance({ salesperson: "ana" });
    expect(data.salesperson).toBe("ana");
  });

  it("a caller with View reports but not the key gets only their own record, whoever they ask for", async () => {
    // The Designer built-in holds reporting.read and not the key.
    const own = await reportsAs("ana", "DESIGNER").monthlyPerformance({ salesperson: "admin" });
    expect(own.salesperson).toBe("ana");
    const detail = await reportsAs("ana", "DESIGNER").salespersonDetail({ salesperson: "admin" });
    expect(detail.salesperson).toBe("ana");

    // Enum MANAGER in the token (which the old check trusted), key not ticked.
    await makeCustomRoleStaff("kim", ["reporting.read"], "MANAGER");
    const kim = await reportsAs("kim", "MANAGER").monthlyPerformance({ salesperson: "ana" });
    expect(kim.salesperson).toBe("kim");
  });

  it("a caller without View reports is refused", async () => {
    await makeStaff("reg", "REGISTER");
    await expect(
      reportsAs("reg", "REGISTER").monthlyPerformance({ salesperson: "ana" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reportsAs("reg", "REGISTER").salespersonDetail({ salesperson: "ana" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("migration 20261118120000 keeps 'any salesperson' for roles the seeder never touches", () => {
  it("grants an edited Manager and Administrator, not a custom or wildcard role, and is idempotent", async () => {
    // An owner edited MANAGER and ADMIN (the seeder now leaves their grants
    // alone) before this key existed, and built a role of their own.
    for (const key of ["MANAGER", "ADMIN"]) {
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permission: KEY } });
    }
    await customRole("FLOOR_LEAD", ["reporting.read"]);
    expect(await grants("MANAGER")).not.toContain(KEY);
    expect(await grants("ADMIN")).not.toContain(KEY);

    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    await prisma.$executeRawUnsafe(MIGRATION_SQL);

    expect((await grants("MANAGER")).filter((p) => p === KEY)).toHaveLength(1);
    expect((await grants("ADMIN")).filter((p) => p === KEY)).toHaveLength(1);
    // Custom roles were always scoped to themselves; they stay so.
    expect(await grants("FLOOR_LEAD")).not.toContain(KEY);
    // The wildcard role holds every key and stores no rows.
    expect(await grants("SUPER_ADMIN")).toEqual([]);
  });
});
