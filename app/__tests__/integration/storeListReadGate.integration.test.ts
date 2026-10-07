// /app/__tests__/integration/storeListReadGate.integration.test.ts
//
// SEC-15 PR 1: three reads, one per need. Before, every screen read the full
// store + stock-location records through /api/warehouse/locations on "Transfer
// stock", so roles without it got an empty store list on Home, Till, Receive
// PO and more, and every other role got aliases, committed-stock flags and
// audit columns it never showed.
//   /api/store-locations                  store list, staff.self
//   /api/store-locations/stock-locations  picker, Transfer stock or Write purchase orders
//   /api/warehouse/locations (GET)        setup, Manage configuration or
//                                         Transfer stock (the two setup screens)
// Real routes, real permission gate, real database; next-auth's session is the
// only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import storeListRoute from "@/pages/api/store-locations/index";
import pickerRoute from "@/pages/api/store-locations/stock-locations";
import setupRoute from "@/pages/api/warehouse/locations/index";

const sessionMock = getServerSession as jest.Mock;
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

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
  query: Record<string, string> = {},
  method = "GET",
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

/** A staff member on a role built in Roles; the enum is DESIGNER, as USE-02 writes. */
async function makeCustomRoleStaff(userId: string, permissions: string[]) {
  await makeUser(userId);
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${userId.toUpperCase()}`,
      name: `Custom ${userId}`,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");

  const main = await prisma.storeLocation.create({
    data: {
      name: "Main Showroom",
      code: "MAIN",
      type: "STORE",
      address: "1 Harbour Rd",
      sortOrder: 1,
      trafficSourceNames: ["Front Door"],
      createdBy: "setup@example.com",
    },
  });
  await prisma.storeLocation.create({
    data: { name: "Old Depot", code: "DEPOT", type: "WAREHOUSE", isActive: false, sortOrder: 2 },
  });
  const back = await prisma.stockLocation.create({
    data: {
      storeLocationId: main.id,
      code: "BACK",
      name: "Back room",
      locationType: "STORAGE",
      locationAliases: ["BR"],
      holdsCommittedStock: true,
      building: "B1",
    },
  });
  await prisma.storeLocation.update({
    where: { id: main.id },
    data: { defaultReceivingStockLocationId: back.id },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the store list is for every staff member, and carries names only", () => {
  it("a role with no grants and HR both read it, with exactly five fields", async () => {
    await makeCustomRoleStaff("nobody", []);
    await makeStaff("hana", "HR");

    for (const who of ["nobody", "hana"]) {
      signInAs(who);
      const res = await call(storeListRoute);
      expect(res.statusCode).toBe(200);
      expect(res.body.locations.map((l: { code: string }) => l.code)).toEqual(["MAIN", "DEPOT"]);
      for (const l of res.body.locations) {
        expect(Object.keys(l).sort()).toEqual(["code", "id", "isActive", "name", "type"]);
      }
    }
  });

  it("filters by type and active, and refuses an unknown type", async () => {
    await makeStaff("hana", "HR");
    signInAs("hana");

    // An ACTIVE warehouse, so each filter is visible on its own: in the shared
    // fixture the only warehouse is also the only inactive location.
    await prisma.storeLocation.create({
      data: { name: "Yard", code: "YARD", type: "WAREHOUSE", sortOrder: 3 },
    });
    const codes = (r: TestRes) => r.body.locations.map((l: { code: string }) => l.code);

    expect(codes(await call(storeListRoute, { type: "STORE" }))).toEqual(["MAIN"]);
    expect(codes(await call(storeListRoute, { isActive: "true" }))).toEqual(["MAIN", "YARD"]);
    expect(codes(await call(storeListRoute, { isActive: "false" }))).toEqual(["DEPOT"]);
    expect(codes(await call(storeListRoute, { type: "WAREHOUSE", isActive: "true" }))).toEqual([
      "YARD",
    ]);

    expect((await call(storeListRoute, { type: "BOGUS" })).statusCode).toBe(400);
    expect((await call(storeListRoute, {}, "POST")).statusCode).toBe(405);
  });

  it("refuses a user with no staff row, a deactivated staff member, and no session", async () => {
    await makeUser("outsider");
    const gone = await makeCustomRoleStaff("gone", []);
    await prisma.staffMember.update({ where: { id: gone.id }, data: { isActive: false } });

    for (const who of ["outsider", "gone"]) {
      signInAs(who);
      expect({ who, status: (await call(storeListRoute)).statusCode }).toEqual({
        who,
        status: 403,
      });
    }
    sessionMock.mockResolvedValue(null);
    expect((await call(storeListRoute)).statusCode).toBe(401);
  });
});

describe("the stock-location picker follows the keys of the screens that pick", () => {
  it("Write purchase orders alone reads it, without setup detail", async () => {
    await makeCustomRoleStaff("bo", ["purchasing.write"]);
    signInAs("bo");

    const res = await call(pickerRoute);
    expect(res.statusCode).toBe(200);
    const main = res.body.locations.find((l: { code: string }) => l.code === "MAIN");
    expect(Object.keys(main).sort()).toEqual(
      [
        "code",
        "defaultReceivingStockLocationId",
        "id",
        "isActive",
        "name",
        "stockLocations",
      ].sort(),
    );
    expect(main.stockLocations).toEqual([
      {
        id: expect.any(Number),
        code: "BACK",
        name: "Back room",
        locationType: "STORAGE",
        isActive: true,
      },
    ]);
    const text = JSON.stringify(res.body);
    for (const hidden of ["holdsCommittedStock", "locationAliases", "Harbour", "B1", "setup@"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("Transfer stock alone reads it; a reports-only role does not", async () => {
    await makeCustomRoleStaff("tom", ["inventory.transfer"]);
    await makeCustomRoleStaff("rex", ["reporting.read"]);

    signInAs("tom");
    expect((await call(pickerRoute)).statusCode).toBe(200);
    signInAs("rex");
    expect((await call(pickerRoute)).statusCode).toBe(403);
  });
});

describe("the setup read answers to either setup screen's key", () => {
  it("Manage configuration alone reads it (Admin > Stores), and so does Transfer stock", async () => {
    await makeCustomRoleStaff("cfg", ["admin.config"]);
    await makeCustomRoleStaff("tom", ["inventory.transfer"]);

    for (const who of ["cfg", "tom"]) {
      signInAs(who);
      expect({ who, status: (await call(setupRoute)).statusCode }).toEqual({ who, status: 200 });
    }
  });

  it("a purchasing-only role does not get the setup detail", async () => {
    await makeCustomRoleStaff("bo", ["purchasing.write"]);
    signInAs("bo");

    expect((await call(setupRoute)).statusCode).toBe(403);
  });

  it("carries what the setup forms send back, not the audit or mapping columns", async () => {
    await makeCustomRoleStaff("cfg", ["admin.config"]);
    signInAs("cfg");

    const { body } = await call(setupRoute);
    const main = body.locations.find((l: { code: string }) => l.code === "MAIN");
    // Exact key lists: the edit forms send these back whole, so a key dropped
    // from the select would be saved back as empty and wipe the stored value.
    expect(Object.keys(main).sort()).toEqual(
      [
        "id",
        "name",
        "code",
        "type",
        "address",
        "city",
        "state",
        "zip",
        "isActive",
        "sortOrder",
        "externalLocationName",
        "defaultReceivingStockLocationId",
        "stockLocations",
      ].sort(),
    );
    expect(Object.keys(main.stockLocations[0]).sort()).toEqual(
      [
        "id",
        "code",
        "name",
        "description",
        "building",
        "floor",
        "area",
        "locationType",
        "squareFootage",
        "isActive",
        "sortOrder",
        "locationAliases",
        "holdsCommittedStock",
      ].sort(),
    );
    expect(main).toMatchObject({ address: "1 Harbour Rd", sortOrder: 1 });
    expect(main.stockLocations[0]).toMatchObject({
      building: "B1",
      locationAliases: ["BR"],
      holdsCommittedStock: true,
    });
  });
});

describe("the setup route's writes", () => {
  // Who may write is storeLocationWriteGate.integration.test.ts's subject
  // (SEC-15 PR 2); here only that the per-method dispatch still routes POST
  // to a write gate and refuses a method it does not serve.
  it("Manage configuration (Admin > Stores) and a manager create stores; PATCH is refused", async () => {
    await makeCustomRoleStaff("cfg", ["admin.config"]);
    await makeStaff("mo", "MANAGER");

    signInAs("cfg");
    expect(
      (await call(setupRoute, {}, "POST", { name: "Cfg", code: "CFG", type: "STORE" })).statusCode,
    ).toBe(201);

    signInAs("mo");
    expect(
      (await call(setupRoute, {}, "POST", { name: "New", code: "NEW", type: "STORE" })).statusCode,
    ).toBe(201);
    expect((await call(setupRoute, {}, "PATCH")).statusCode).toBe(405);
  });
});
