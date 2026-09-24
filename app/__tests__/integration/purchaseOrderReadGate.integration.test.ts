// /app/__tests__/integration/purchaseOrderReadGate.integration.test.ts
//
// SEC-13 tranche 3: the purchase-order list answers to "View purchasing"
// (purchasing.read), and a service case finds a PO to link through its own
// lookup, which answers to the case's "Work service" key (service.write) and
// returns number and vendor only. Before, any signed-in session read the full
// list with totals. Real routes, real permission gate, real database;
// next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
// The list route read the session through next-auth/next before this change.
// The same mock answers there, so reverting it shows its real behaviour.
jest.mock("next-auth/next", () => ({
  getServerSession: (...args: unknown[]) => jest.requireMock("next-auth").getServerSession(...args),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import poListRoute from "@/pages/api/purchasing/orders/index";
import poLookupRoute from "@/pages/api/service/purchase-order-lookup";

const sessionMock = getServerSession as jest.Mock;

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

async function get(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  query: Record<string, string>,
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method: "GET", query, body: {}, cookies: {} } as any;
  await route(req, res);
  return res;
}

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
  const vendor = await prisma.vendor.create({ data: { name: "Oakline Works" } });
  await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-7001",
      vendorId: vendor.id,
      notes: "rush order for the Hartwell sofa",
      lineItems: {
        create: [{ orderedQuantity: 2, unitCost: 450 }],
      },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the purchase-order list follows View purchasing", () => {
  it("a service role without it gets 403", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");
    signInAs("cara");

    expect((await get(poListRoute, {})).statusCode).toBe(403);
  });

  it("a role holding it reads the list with totals", async () => {
    await makeStaff("bo", "BUYER");
    signInAs("bo");

    const res = await get(poListRoute, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0]).toMatchObject({ poNumber: "PO-7001", totalCost: 900 });
  });
});

describe("a service case links a PO through its own lookup", () => {
  it("service staff find a PO by number or vendor, and see nothing else", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");
    signInAs("cara");

    const byNumber = await get(poLookupRoute, { search: "7001" });
    expect(byNumber.statusCode).toBe(200);
    expect(byNumber.body.orders).toEqual([
      { id: expect.any(Number), poNumber: "PO-7001", vendorName: "Oakline Works" },
    ]);

    const byVendor = await get(poLookupRoute, { search: "oakline" });
    expect(byVendor.body.orders).toHaveLength(1);
  });

  it("never searches PO notes", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");
    signInAs("cara");

    const res = await get(poLookupRoute, { search: "Hartwell" });
    expect(res.statusCode).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  it("an empty search returns nothing", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");
    signInAs("cara");

    const res = await get(poLookupRoute, { search: "  " });
    expect(res.statusCode).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  it("a role without Work service gets 403", async () => {
    await makeStaff("bo", "BUYER");
    signInAs("bo");

    expect((await get(poLookupRoute, { search: "7001" })).statusCode).toBe(403);
  });
});

describe("custom roles follow their Roles grants", () => {
  it("service-only reaches the lookup, not the list; purchasing-only the reverse", async () => {
    await makeCustomRoleStaff("sam", ["service.read", "service.write"]);
    await makeCustomRoleStaff("pat", ["purchasing.read"]);

    signInAs("sam");
    expect((await get(poLookupRoute, { search: "7001" })).statusCode).toBe(200);
    expect((await get(poListRoute, {})).statusCode).toBe(403);

    signInAs("pat");
    expect((await get(poLookupRoute, { search: "7001" })).statusCode).toBe(403);
    expect((await get(poListRoute, {})).statusCode).toBe(200);
  });
});
