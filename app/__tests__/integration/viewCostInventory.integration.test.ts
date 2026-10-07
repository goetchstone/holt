// /app/__tests__/integration/viewCostInventory.integration.test.ts
//
// "View cost" (catalog.cost, SEC-14), first screens: inventory valued at cost.
// The Inventory hub's on-hand totals (by department, by location) and Summary
// Details are served to everyone "View inventory" admits; the cost columns go
// only to a caller who also holds "View cost". Strip, never deny.
//
// Also here: the gate mechanism that answers the extra key from the same staff
// read (requirePermission and requireAuthWithRole), and migration
// 20261001120000, which grants the key to edited and custom roles.
//
// Real routes, real gates, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { requireAuthWithRole, type CallerAccess } from "@/lib/auth/requireAuth";
import { WITH_COST } from "@/lib/auth/costVisibility";
import byDepartment from "@/pages/api/inventory/onhand-by-department";
import byLocation from "@/pages/api/inventory/onhand-by-location";
import summaryDetails from "@/pages/api/inventory/summary-details";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../prisma/migrations/20261001120000_grant_catalog_cost/migration.sql"),
  "utf8",
);

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(route: Route, userId: string, query: object = {}, impersonate?: string) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      payload = p;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await route(
    {
      method: "GET",
      query,
      body: {},
      cookies: impersonate ? { "holt-impersonate": impersonate } : {},
    } as unknown as NextApiRequest,
    res,
  );
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) };
}

function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost/i.test(k) ? [k] : []),
      ...costKeys(v),
    ]);
  }
  return [];
}

async function makeRole(key: string, permissions: string[]) {
  return prisma.role.create({
    data: {
      key,
      name: key,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
}

async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: enumRole as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

async function setGrants(roleKey: string, permissions: string[]) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permission })),
  });
  await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
  invalidateRoleGrantCache();
}

const ROUTES: Array<[string, Route, object]> = [
  ["on-hand by department", byDepartment, {}],
  ["on-hand by location", byLocation, {}],
  ["summary details", summaryDetails, { groupType: "department", groupName: "Rugs" }],
];

describe("inventory valued at cost follows View cost", () => {
  beforeAll(async () => {
    await resetTestDb();
    invalidateRoleGrantCache();
    await syncBuiltInRoles({ prisma });
    await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

    const store = await prisma.storeLocation.create({
      data: { name: "Main Street", code: "MAIN", type: "STORE" },
    });
    const vendor = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
    const department = await prisma.department.create({ data: { name: "Rugs" } });
    const category = await prisma.category.create({
      data: { name: "Area Rugs", departmentId: department.id },
    });
    const rug = await prisma.product.create({
      data: {
        productNumber: "QH-RUG-01",
        name: "Quarry Rug",
        // The by-department/by-location totals match physical counts through
        // externalId, so a product without one has its counts dropped there (a
        // separate bug on main, tracked on its own).
        externalId: 7001,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseCost: 200,
        baseRetail: 500,
      },
    });
    await prisma.inventorySnapshot.create({
      data: { productId: rug.id, storeLocationId: store.id, quantity: 3 },
    });
    await prisma.physicalInventoryCount.create({
      data: { productId: rug.id, stockLocation: store.name, quantity: 2 },
    });

    await makeStaff("mia", "MANAGER");
    await makeRole("COUNTER", ["inventory.read"]); // a custom role: stock, not cost
    await makeStaff("cal", "COUNTER", "DESIGNER");
    await makeStaff("ada", "ADMIN");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(ROUTES)("%s: a holder gets the cost columns", async (_name, route, query) => {
    const { status, body } = await call(route, "mia", query);
    expect(status).toBe(200);
    expect(body.costVisible).toBe(true);
    expect(body.rows[0]).toMatchObject({ expectedQty: 3, countedQty: 2, expectedCost: 600 });
  });

  it.each(ROUTES)(
    "%s: a role without View cost gets the same rows without cost, not a refusal",
    async (_name, route, query) => {
      const { status, body } = await call(route, "cal", query);
      expect(status).toBe(200);
      expect(body.costVisible).toBe(false);
      expect(body.rows[0]).toMatchObject({ expectedQty: 3, countedQty: 2, varianceQty: -1 });
      expect(costKeys(body.rows)).toEqual([]);
    },
  );

  it("an admin viewing as a role sees what that role sees", async () => {
    expect((await call(byDepartment, "ada", {}, "COUNTER")).body.costVisible).toBe(false);
    expect((await call(byDepartment, "ada", {}, "REGISTER")).body.costVisible).toBe(true);
  });

  it("unticking View cost on a built-in role takes the columns away, ticking brings them back", async () => {
    const manager = await prisma.role.findUniqueOrThrow({
      where: { key: "MANAGER" },
      include: { permissions: true },
    });
    const original = manager.permissions.map((p) => p.permission);
    try {
      await setGrants(
        "MANAGER",
        original.filter((p) => p !== "catalog.cost"),
      );
      expect((await call(byLocation, "mia")).body.costVisible).toBe(false);
    } finally {
      await setGrants("MANAGER", original);
    }
    expect((await call(byLocation, "mia")).body.costVisible).toBe(true);
  });

  it("a role-list gate answers View cost from the caller's Role, not the list", async () => {
    let seen: CallerAccess | null = null;
    const probe = requireAuthWithRole(
      ["MANAGER", "ADMIN"],
      async (_req, res, _session, access) => {
        seen = access;
        res.status(200).json({});
      },
      WITH_COST,
    );
    await call(probe, "mia");
    expect(seen).toEqual({ holds: { "catalog.cost": true } });

    const manager = await prisma.role.findUniqueOrThrow({
      where: { key: "MANAGER" },
      include: { permissions: true },
    });
    const original = manager.permissions.map((p) => p.permission);
    try {
      await setGrants(
        "MANAGER",
        original.filter((p) => p !== "catalog.cost"),
      );
      await call(probe, "mia");
      expect(seen).toEqual({ holds: { "catalog.cost": false } });
    } finally {
      await setGrants("MANAGER", original);
    }
  });
});

describe("migration 20261001120000 grants View cost to edited and custom roles that reach cost today", () => {
  // Every clause of the rule has a role here that only that clause admits, so
  // deleting any part of the SQL turns a test red.
  async function freshRoles() {
    await resetTestDb();
    invalidateRoleGrantCache();
    await syncBuiltInRoles({ prisma });
  }

  /** Runs the migration as the only source of the key: the seeder's rows for
   *  unedited built-ins are cleared first, so the rule must reproduce them. */
  async function migrate() {
    await prisma.rolePermission.deleteMany({
      where: { permission: "catalog.cost", role: { isSystem: true, grantsCustomized: false } },
    });
    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    await prisma.$executeRawUnsafe(MIGRATION_SQL); // idempotent: a second run is a no-op
  }

  async function granted(): Promise<string[]> {
    const rows = await prisma.rolePermission.findMany({
      where: { permission: "catalog.cost" },
      select: { role: { select: { key: true } } },
    });
    return rows.map((r) => r.role.key).sort();
  }

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("grants by the same rule as the built-in lists, and never to a wildcard role", async () => {
    await freshRoles();
    // Edited built-ins: the seeder leaves them alone, so only the migration
    // can grant them the new key. Their current grants decide.
    await setGrants("WAREHOUSE", ["purchasing.receive"]); // receiving shows PO cost
    await setGrants("MANAGER", []); // role lists name MANAGER
    await setGrants("ADMIN", []); // and ADMIN
    await setGrants("DISPATCH", ["warehouse.operate", "warehouse.read"]); // no cost path
    // Custom roles carry the enum DESIGNER, so only the key clauses apply:
    // one role per key.
    await makeRole("ONLY_CATALOG_READ", ["catalog.read"]);
    await makeRole("ONLY_CATALOG_WRITE", ["catalog.write"]);
    await makeRole("ONLY_INVENTORY", ["inventory.read"]);
    await makeRole("ONLY_REPORTS", ["reporting.read"]);
    await makeRole("ONLY_SETTINGS", ["admin.settings"]);
    await makeRole("BOOKKEEPER", ["accounting.read", "purchasing.write"]);
    // Not granted: no cost path, or a path deliberately left out.
    await makeRole("RUNNER", ["warehouse.operate"]);
    await makeRole("ARCHIVIST", ["admin.data"]); // full backups are exempt
    await makeRole("BOOKS_ONLY", ["accounting.read"]);
    await makeRole("BUYS_ONLY", ["purchasing.write"]);
    await makeRole("PO_READER", ["purchasing.read"]); // the PO clause is WAREHOUSE's, by key
    // A wildcard role holds every key without rows; the migration adds none,
    // even when it stores a row that would otherwise qualify.
    await prisma.role.create({
      data: {
        key: "CO_OWNER",
        name: "Co-owner",
        isSystem: false,
        grantsAllPermissions: true,
        permissions: { create: [{ permission: "catalog.read" }] },
      },
    });

    // A row from a partial earlier run survives into the migration and must
    // not make it fail or duplicate.
    await prisma.rolePermission.deleteMany({
      where: { permission: "catalog.cost", role: { isSystem: true, grantsCustomized: false } },
    });
    const reports = await prisma.role.findUniqueOrThrow({ where: { key: "ONLY_REPORTS" } });
    await prisma.rolePermission.create({
      data: { roleId: reports.id, permission: "catalog.cost" },
    });

    await migrate();

    expect(await granted()).toEqual(
      [
        // edited built-ins
        "ADMIN",
        "MANAGER",
        "WAREHOUSE",
        // unedited built-ins, reproduced from their lists
        "BUYER",
        "DATA_ENTRY",
        "DEPARTMENT_HEAD",
        "DESIGNER",
        "GENERAL_MANAGER",
        "HR",
        "MARKETING",
        "REGISTER",
        // custom roles
        "BOOKKEEPER",
        "ONLY_CATALOG_READ",
        "ONLY_CATALOG_WRITE",
        "ONLY_INVENTORY",
        "ONLY_REPORTS",
        "ONLY_SETTINGS",
      ].sort(),
    );
  });

  it("grants an edited WAREHOUSE that can only read purchase orders", async () => {
    await freshRoles();
    await setGrants("WAREHOUSE", ["purchasing.read"]);
    await migrate();
    expect(await granted()).toContain("WAREHOUSE");
  });
});
