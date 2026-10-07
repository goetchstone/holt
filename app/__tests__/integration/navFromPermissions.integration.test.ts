// /app/__tests__/integration/navFromPermissions.integration.test.ts
//
// Real-DB half of "the menu is a function of what you can do". The pure filter
// is unit-tested exhaustively in __tests__/navPermissions.test.ts; what only
// Postgres can show is that the thing feeding it is the GRANT TABLE and nothing
// else:
//
//   - a role the deployment invented last Tuesday, which no code has ever heard
//     of, gets exactly the menu its RolePermission rows earn — the claim the old
//     hardcoded role table could not make;
//   - revoking a grant removes the item, so the menu cannot drift away from the
//     guards the way NavPermission rows did;
//   - SUPER_ADMIN's wildcard (ZERO RolePermission rows on purpose) still yields
//     the whole menu;
//   - a deactivated staff member's menu is empty, not "whatever their role
//     used to be";
//   - an unlinked staff member (roleId = NULL) resolves through the built-in
//     definitions, so the migration is adoptable one staff row at a time.
//
// NOTE: this file's schema comes from `prisma db push` (jest.integration.setup
// .ts), not from `prisma migrate deploy` — same caveat as rbacFoundation.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache, resolveGrantedPermissions } from "@/lib/auth/permissionResolver";
import { getVisibleNavItems, NAV_ITEMS } from "@/lib/auth/navPermissions";

const ALL_LABELS = NAV_ITEMS.map((i) => i.label);

/** The staff row shape the NextAuth jwt callback selects. */
async function staffRowFor(userId: string) {
  return prisma.staffMember.findFirst({
    where: { userId },
    select: { role: true, roleId: true, isActive: true },
  });
}

/** End to end: staff row -> DB grants -> menu labels. */
async function menuFor(userId: string): Promise<string[]> {
  const staff = await staffRowFor(userId);
  const permissions = await resolveGrantedPermissions(staff);
  return getVisibleNavItems(permissions).map((i) => i.label);
}

async function makeStaff(opts: {
  userId: string;
  roleKey: string;
  /** StaffRole enum value; defaults to roleKey when that is itself an enum value. */
  enumRole?: string;
  isActive?: boolean;
  /** Pass false to leave roleId NULL and exercise the enum fallback. */
  link?: boolean;
}) {
  await prisma.user.create({ data: { id: opts.userId, email: `${opts.userId}@example.com` } });
  const role = await prisma.role.findUnique({ where: { key: opts.roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: opts.userId,
      displayName: opts.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: (opts.enumRole ?? opts.roleKey) as any,
      roleId: opts.link === false ? null : (role?.id ?? null),
      isActive: opts.isActive ?? true,
    },
  });
}

/** A role the product has never heard of, holding exactly `permissions`. */
async function makeCustomRole(key: string, permissions: string[]) {
  await prisma.role.create({
    data: {
      key,
      name: key,
      description: `${key} (invented by this deployment)`,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  invalidateRoleGrantCache();
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
});

describe("a role the deployment invented", () => {
  it("holding exactly sales.read sees Sales, and not Warehouse", async () => {
    await makeCustomRole("FLOOR_LEAD", ["sales.read"]);
    // The StaffRole enum still has to hold *something*; roleId is what decides.
    await makeStaff({ userId: "floor-lead", roleKey: "FLOOR_LEAD", enumRole: "DESIGNER" });

    const menu = await menuFor("floor-lead");
    expect(menu).toContain("Sales");
    expect(menu).not.toContain("Warehouse");
    expect(menu).not.toContain("Reports");
    expect(menu).not.toContain("Admin");
    // The baseline floor is under every role, invented ones included.
    expect(menu).toContain("Time");
  });

  it("gets a wider menu the moment a grant is added — no deploy", async () => {
    await makeCustomRole("FLOOR_LEAD", ["sales.read"]);
    await makeStaff({ userId: "floor-lead", roleKey: "FLOOR_LEAD", enumRole: "DESIGNER" });
    expect(await menuFor("floor-lead")).not.toContain("Warehouse");

    const role = await prisma.role.findUniqueOrThrow({ where: { key: "FLOOR_LEAD" } });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permission: "warehouse.read" },
    });
    invalidateRoleGrantCache();

    expect(await menuFor("floor-lead")).toContain("Warehouse");
  });

  it("loses the item when the grant is revoked", async () => {
    // This is the property NavPermission rows never had: the thing that hides
    // the menu item is the same row the guards read.
    await makeCustomRole("FLOOR_LEAD", ["sales.read", "reporting.read"]);
    await makeStaff({ userId: "floor-lead", roleKey: "FLOOR_LEAD", enumRole: "DESIGNER" });
    expect(await menuFor("floor-lead")).toContain("Reports");

    const role = await prisma.role.findUniqueOrThrow({ where: { key: "FLOOR_LEAD" } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: "reporting.read" },
    });
    invalidateRoleGrantCache();

    const menu = await menuFor("floor-lead");
    expect(menu).not.toContain("Reports");
    expect(menu).toContain("Sales");
  });

  it("holding nothing at all still reaches its own timeclock", async () => {
    await makeCustomRole("SEASONAL_HELP", []);
    await makeStaff({ userId: "seasonal", roleKey: "SEASONAL_HELP", enumRole: "REGISTER" });

    expect(await menuFor("seasonal")).toEqual(["Time"]);
  });
});

describe("built-in roles, resolved from the seeded rows", () => {
  it("SUPER_ADMIN sees everything through the wildcard, with zero grant rows", async () => {
    await makeStaff({ userId: "owner", roleKey: "SUPER_ADMIN" });

    const role = await prisma.role.findUniqueOrThrow({
      where: { key: "SUPER_ADMIN" },
      include: { permissions: true },
    });
    expect(role.grantsAllPermissions).toBe(true);
    expect(role.permissions).toHaveLength(0);

    expect(await menuFor("owner")).toEqual(ALL_LABELS);
  });

  it("MANAGER sees Admin — it can use accounting, pricing and commission inside it", async () => {
    await makeStaff({ userId: "manager", roleKey: "MANAGER" });

    const menu = await menuFor("manager");
    expect(menu).toContain("Sales");
    expect(menu).toContain("Warehouse");
    expect(menu).toContain("Reports");
    // Admin is a hub whose cards self-filter. Requiring one admin.* key for the
    // whole entry hid it from a Manager while every page inside stayed
    // reachable by URL, so NAV_ITEMS lists several keys and the entry appears
    // when the viewer holds any. accounting.read is the one that earns it here.
    expect(menu).toContain("Admin");
  });

  it("REGISTER does not see Admin — it holds none of that hub's keys", async () => {
    // The negative half, which the assertion above used to be carrying. Without
    // it, "any of" could degrade into "everyone" and nothing would notice.
    await makeStaff({ userId: "cashier", roleKey: "REGISTER" });

    const menu = await menuFor("cashier");
    expect(menu).toContain("Sales");
    expect(menu).not.toContain("Admin");
    expect(menu).not.toContain("Purchasing");
  });

  it("resolves through the built-in definitions when roleId is NULL", async () => {
    await makeStaff({ userId: "unlinked", roleKey: "WAREHOUSE", link: false });

    const staff = await staffRowFor("unlinked");
    expect(staff?.roleId).toBeNull();

    const menu = await menuFor("unlinked");
    // Service and Helpdesk belong here: WAREHOUSE holds service.read AND
    // service.write in permissionCatalog.ts, and both nav entries gate on
    // service.read. The person unwrapping a damaged delivery is the person who
    // raises the ticket. Mirrors the unit expectation in
    // __tests__/navPermissions.test.ts -- keep the two in step.
    //
    // Do NOT trim this back to make it pass. Hiding a link to a page the role
    // can actually open is the NavPermission bug this branch exists to remove.
    // If WAREHOUSE should not reach service, drop the grant in
    // permissionCatalog.ts and the menu follows on its own.
    expect(menu).toEqual([
      "Sales",
      "Service",
      "Purchasing",
      "Warehouse",
      "Inventory",
      "Helpdesk",
      "Time",
      "Tools",
    ]);
  });
});

describe("deactivation", () => {
  it("empties the menu — an inactive staff row holds nothing, floor included", async () => {
    await makeStaff({ userId: "gone", roleKey: "MANAGER", isActive: false });

    expect(await resolveGrantedPermissions(await staffRowFor("gone"))).toEqual([]);
    expect(await menuFor("gone")).toEqual([]);
  });

  it("empties the menu for a user with no staff row at all", async () => {
    await prisma.user.create({ data: { id: "stranger", email: "stranger@example.com" } });

    expect(await menuFor("stranger")).toEqual([]);
  });
});
