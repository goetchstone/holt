// /app/__tests__/integration/storeLocationWriteGate.integration.test.ts
//
// SEC-15 PR 2: setting up stores and stock locations is its own switch, "Set
// up stores and stock locations" (inventory.locations.manage). Store writes
// also accept "Manage configuration" (Admin > Stores' key). Before, store
// writes and stock-location create rode on "Transfer stock" plus a hardcoded
// MANAGER/ADMIN check inside the routes, and stock-location edit/delete on
// "Adjust inventory", so the owner could not decide who configures stores
// without also deciding who moves stock. The switch starts on for the union of
// those two old audiences, for built-in, edited and custom roles alike. Real routes, real permission gate,
// real database; next-auth's session is the only mock.

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
import storesRoute from "@/pages/api/warehouse/locations/index";
import storeRoute from "@/pages/api/warehouse/locations/[id]";
import storeStockLocationsRoute from "@/pages/api/warehouse/locations/[id]/stock-locations";
import stockLocationRoute from "@/pages/api/warehouse/stock-locations/[id]";

const sessionMock = getServerSession as jest.Mock;
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20260930120000_grant_inventory_locations_manage/migration.sql",
  ),
  "utf8",
);

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as TestRes;
}

async function call(
  route: Route,
  method: string,
  query: Record<string, string> = {},
  body: Record<string, unknown> = {},
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method, query, body, cookies: {} } as any;
  await route(req, res);
  return res;
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

/** A staff member on a role built in Roles; the enum is DESIGNER, as USE-02 writes. */
async function makeCustomRoleStaff(userId: string, permissions: string[]) {
  await makeUser(userId);
  const role = await customRole(`CUSTOM_${userId.toUpperCase()}`, permissions);
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

async function grants(roleKey: string): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { permissions: { select: { permission: true } } },
  });
  return role.permissions.map((p) => p.permission);
}

let seq = 0;

/** Each of the six setup writes, run against its own fresh rows. */
async function writes(): Promise<Record<string, number>> {
  seq += 1;
  const store = await prisma.storeLocation.create({
    data: { name: `Probe ${seq}`, code: `P${seq}`, type: "STORE" },
  });
  const spare = await prisma.storeLocation.create({
    data: { name: `Spare ${seq}`, code: `S${seq}`, type: "STORE" },
  });
  const bin = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: `B${seq}`, name: "Bin", locationType: "STOCK" },
  });
  const binToDelete = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: `D${seq}`, name: "Old bin", locationType: "STOCK" },
  });
  const storeId = String(store.id);
  return {
    "store POST": (
      await call(storesRoute, "POST", {}, { name: `New ${seq}`, code: `N${seq}`, type: "STORE" })
    ).statusCode,
    "store PUT": (await call(storeRoute, "PUT", { id: storeId }, { name: `Renamed ${seq}` }))
      .statusCode,
    "store DELETE": (await call(storeRoute, "DELETE", { id: String(spare.id) })).statusCode,
    "stock POST": (
      await call(
        storeStockLocationsRoute,
        "POST",
        { id: storeId },
        { code: `C${seq}`, name: "New bin" },
      )
    ).statusCode,
    "stock PUT": (
      await call(stockLocationRoute, "PUT", { id: String(bin.id) }, { holdsCommittedStock: true })
    ).statusCode,
    "stock DELETE": (await call(stockLocationRoute, "DELETE", { id: String(binToDelete.id) }))
      .statusCode,
  };
}

function statusClass(result: Record<string, number>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, v >= 200 && v < 300 ? "ok" : String(v)]),
  );
}

const ALL_OK = {
  "store POST": "ok",
  "store PUT": "ok",
  "store DELETE": "ok",
  "stock POST": "ok",
  "stock PUT": "ok",
  "stock DELETE": "ok",
};
const ALL_403 = Object.fromEntries(Object.keys(ALL_OK).map((k) => [k, "403"]));

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("store and stock-location setup follows its own switch", () => {
  it("a custom role holding only the new switch can make every setup write", async () => {
    await makeCustomRoleStaff("sam", ["inventory.locations.manage"]);
    signInAs("sam");

    expect(statusClass(await writes())).toEqual(ALL_OK);
  });

  it("Transfer stock alone no longer sets anything up, but still reads the setup screen", async () => {
    await makeCustomRoleStaff("tom", ["inventory.transfer"]);
    signInAs("tom");

    expect(statusClass(await writes())).toEqual(ALL_403);
    expect((await call(storesRoute, "GET")).statusCode).toBe(200);
  });

  it("a manager whose switch the owner unticked keeps moving stock but cannot set up", async () => {
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.role.update({ where: { id: manager.id }, data: { grantsCustomized: true } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: manager.id, permission: "inventory.locations.manage" },
    });
    invalidateRoleGrantCache();
    await makeStaff("mo", "MANAGER");
    signInAs("mo");

    expect(statusClass(await writes())).toEqual(ALL_403);
    expect((await call(storesRoute, "GET")).statusCode).toBe(200);
  });

  it("Manage configuration alone writes stores (Admin > Stores) but not stock locations", async () => {
    await makeCustomRoleStaff("cfg", ["admin.config"]);
    signInAs("cfg");

    expect(statusClass(await writes())).toEqual({
      ...ALL_OK,
      "stock POST": "403",
      "stock PUT": "403",
      "stock DELETE": "403",
    });
  });
});

describe("the built-in defaults: everyone who could set anything up before, not WAREHOUSE", () => {
  it.each(["MANAGER", "GENERAL_MANAGER", "SUPER_ADMIN"])(
    "%s can make every setup write",
    async (key) => {
      const userId = `u-${key.toLowerCase()}`;
      await makeStaff(userId, key);
      signInAs(userId);

      expect(statusClass(await writes())).toEqual(ALL_OK);
    },
  );

  it("WAREHOUSE still reads setup (list, one store, its stock locations) but does not change it", async () => {
    await makeStaff("wes", "WAREHOUSE");
    signInAs("wes");

    expect(statusClass(await writes())).toEqual(ALL_403);
    const store = await prisma.storeLocation.create({
      data: { name: "Read me", code: "READ", type: "STORE" },
    });
    expect((await call(storesRoute, "GET")).statusCode).toBe(200);
    expect((await call(storeRoute, "GET", { id: String(store.id) })).statusCode).toBe(200);
    expect((await call(storeStockLocationsRoute, "GET", { id: String(store.id) })).statusCode).toBe(
      200,
    );
  });
});

describe("migration 20260930120000 grants the switch to the union of the two old audiences", () => {
  it("edited ADMIN/MANAGER holding Transfer stock and any role holding Adjust inventory; nobody else", async () => {
    // Edited built-ins: the seeder has stopped reconciling them.
    for (const key of ["MANAGER", "WAREHOUSE"]) {
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
      await prisma.rolePermission.deleteMany({
        where: { roleId: role.id, permission: "inventory.locations.manage" },
      });
    }
    await customRole("TRANSFER_ONLY", ["inventory.transfer"]);
    await customRole("ADJUST_ONLY", ["inventory.adjust"]);
    await customRole("BOTH", ["inventory.transfer", "inventory.adjust"]);
    await customRole("NEITHER", ["sales.read"]);

    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    await prisma.$executeRawUnsafe(MIGRATION_SQL);

    const count = async (key: string) =>
      (await grants(key)).filter((p) => p === "inventory.locations.manage").length;
    expect({
      MANAGER: await count("MANAGER"),
      WAREHOUSE: await count("WAREHOUSE"),
      TRANSFER_ONLY: await count("TRANSFER_ONLY"),
      ADJUST_ONLY: await count("ADJUST_ONLY"),
      BOTH: await count("BOTH"),
      NEITHER: await count("NEITHER"),
      SUPER_ADMIN: await count("SUPER_ADMIN"),
    }).toEqual({
      MANAGER: 1,
      WAREHOUSE: 0,
      TRANSFER_ONLY: 0,
      ADJUST_ONLY: 1,
      BOTH: 1,
      NEITHER: 0,
      SUPER_ADMIN: 0,
    });
  });
});
