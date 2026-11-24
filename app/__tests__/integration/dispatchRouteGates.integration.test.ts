// /app/__tests__/integration/dispatchRouteGates.integration.test.ts
//
// The 2026-11 role-list sweep moved the last six /api/dispatch routes off the
// MANAGER/ADMIN/WAREHOUSE role list and onto "Operate warehouse"
// (warehouse.operate), the key the rest of dispatch (runs, stops, vehicles,
// pick lists, the unassigned pool) was already on: the board's unassigned
// orders and drag-to-assign, the planner and its pencil-in, Ready to Deliver,
// and ticking pick-list lines. The role list matched the staff enum, so it
// refused Dispatch, Installer and General Manager, who hold the key by default,
// refused every custom role (whose enum is DESIGNER) whatever Roles granted,
// and kept admitting an edited WAREHOUSE role after the owner unticked the key.
//
// Each route is probed with a method it does not serve. The gate runs before
// the handler, so a refused caller gets 403 and an admitted one reaches the
// handler, which answers 405: no fixture rows, and nothing is written. Real
// routes, real permission gate, real database; next-auth's session is the
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
import assignOrderRoute from "@/pages/api/dispatch/assign-order";
import deliveryPlannerRoute from "@/pages/api/dispatch/delivery-planner";
import ordersByZoneRoute from "@/pages/api/dispatch/orders-by-zone";
import pencilInRoute from "@/pages/api/dispatch/pencil-in";
import pickListItemsRoute from "@/pages/api/dispatch/pick-lists/[id]/items";
import readyToDeliverRoute from "@/pages/api/dispatch/ready-to-deliver";

const sessionMock = getServerSession as jest.Mock;
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

/** Each route, with a method it does not serve. */
const PROBES: Array<{
  name: string;
  route: Route;
  method: string;
  query?: Record<string, string>;
}> = [
  { name: "assign-order", route: assignOrderRoute, method: "GET" },
  { name: "delivery-planner", route: deliveryPlannerRoute, method: "POST" },
  { name: "orders-by-zone", route: ordersByZoneRoute, method: "POST" },
  { name: "pencil-in", route: pencilInRoute, method: "GET" },
  { name: "pick-list items", route: pickListItemsRoute, method: "GET", query: { id: "1" } },
  { name: "ready-to-deliver", route: readyToDeliverRoute, method: "POST" },
];

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

/** What each route answers the signed-in caller: "handler" when the gate let
 *  the request through (the handler's own 405), otherwise the status. */
async function outcomes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { name, route, method, query } of PROBES) {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { method, query: query ?? {}, body: {}, cookies: {} } as any;
    await route(req, res);
    out[name] = res.statusCode === 405 ? "handler" : String(res.statusCode);
  }
  return out;
}

const ALL_ADMITTED = Object.fromEntries(PROBES.map(({ name }) => [name, "handler"]));
const ALL_403 = Object.fromEntries(PROBES.map(({ name }) => [name, "403"]));

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

/** A signed-in staff member holding a built-in role (enum and roleId agree). */
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
      name: userId,
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the six routes admit every built-in role that holds Operate warehouse", () => {
  it.each([
    // The role list's audience, the Owner through its ADMIN rule.
    "SUPER_ADMIN",
    "ADMIN",
    "MANAGER",
    "WAREHOUSE",
    // Hold the key by default; the role list refused them.
    "GENERAL_MANAGER",
    "DISPATCH",
    "INSTALLER",
  ])("%s reaches every route", async (key) => {
    const userId = `u-${key.toLowerCase()}`;
    await makeStaff(userId, key);
    signInAs(userId);

    expect(await outcomes()).toEqual(ALL_ADMITTED);
  });

  it.each([
    "DESIGNER",
    "REGISTER",
    "MARKETING",
    "BUYER",
    "DEPARTMENT_HEAD",
    "DATA_ENTRY",
    "HR",
    "CUSTOMER_SERVICE",
  ])("%s, which does not hold it, is refused every route", async (key) => {
    const userId = `u-${key.toLowerCase()}`;
    await makeStaff(userId, key);
    signInAs(userId);

    expect(await outcomes()).toEqual(ALL_403);
  });
});

describe("custom and edited roles follow their Roles grants, not the staff enum", () => {
  it("a custom role holding Operate warehouse reaches every route", async () => {
    await makeCustomRoleStaff("cara", ["warehouse.operate"]);
    signInAs("cara");

    expect(await outcomes()).toEqual(ALL_ADMITTED);
  });

  it("View warehouse alone does not reach them: they are on Operate warehouse, like the rest of dispatch", async () => {
    // The two keys have the same default holders, so only a role built in
    // Roles can tell which one the routes check.
    await makeCustomRoleStaff("vic", ["warehouse.read"]);
    signInAs("vic");

    expect(await outcomes()).toEqual(ALL_403);
  });

  it("a WAREHOUSE role whose key the owner unticked is refused, although its enum still says WAREHOUSE", async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "WAREHOUSE" } });
    await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: "warehouse.operate" },
    });
    invalidateRoleGrantCache();
    await makeStaff("wes", "WAREHOUSE");
    signInAs("wes");

    expect(await outcomes()).toEqual(ALL_403);
  });
});
