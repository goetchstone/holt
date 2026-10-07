// /app/__tests__/integration/productSearchGate.integration.test.ts
//
// SEC-13 tranche 3: product search answers to the key of any screen that uses
// it (All Products, Create Variant, New Quote, POS, Reconcile Photos, New
// Transfer), so the owner's Roles settings decide who searches. It no longer
// sends the vendor row (account number, discounts, markup, terms, contacts) or
// staff emails. Before, any signed-in session searched the whole catalog with
// all of that attached. Real route, real permission gate, real database;
// next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
// The route read the session through next-auth/next before this change. The
// same mock answers there, so reverting it shows its real behaviour.
jest.mock("next-auth/next", () => ({
  getServerSession: (...args: unknown[]) => jest.requireMock("next-auth").getServerSession(...args),
}));

import type { NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import productsRoute from "@/pages/api/products/index";

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

async function search(query: Record<string, string> = { search: "Hartwell" }): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method: "GET", query, body: {}, cookies: {} } as any;
  await productsRoute(req, res);
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

  const vendor = await prisma.vendor.create({
    data: {
      name: "Oakline Works",
      accountNumber: "ACCT-4471",
      defaultDiscount: 0.4,
      defaultMarkup: 2.2,
      costMultiplier: 0.45,
      paymentTerms: "Net 30",
      email: "orders@oakline.example",
      notes: "ask for the spring rate",
      createdBy: "buyer@example.com",
    },
  });
  const department = await prisma.department.create({ data: { name: "Upholstery" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  await prisma.product.create({
    data: {
      productNumber: "OW-100",
      name: "Hartwell Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseCost: 900,
      baseRetail: 1980,
      createdBy: "buyer@example.com",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("product search follows the keys of the screens that use it", () => {
  it.each([
    ["catalog.read", "All Products"],
    ["catalog.write", "Create Variant"],
    ["sales.write", "New Quote"],
    ["pos.operate", "POS"],
    ["inventory.count", "Reconcile Photos"],
    ["inventory.transfer", "New Transfer"],
  ])("%s alone (%s) admits", async (key) => {
    await makeCustomRoleStaff("solo", [key]);
    signInAs("solo");

    const res = await search();
    expect(res.statusCode).toBe(200);
    expect(res.body.products.map((p: { name: string }) => p.name)).toEqual(["Hartwell Sofa"]);
  });

  it("a role holding none of them gets 403", async () => {
    await makeCustomRoleStaff("rex", ["reporting.read", "customer.read"]);
    signInAs("rex");

    expect((await search()).statusCode).toBe(403);
  });

  it("a built-in role without any of them gets 403", async () => {
    await makeStaff("dee", "DISPATCH");
    signInAs("dee");

    expect((await search()).statusCode).toBe(403);
  });
});

describe("the search carries what the screens read, not the vendor's terms", () => {
  it("names instead of rows, no vendor terms or contacts, no staff emails", async () => {
    await makeStaff("mo", "MANAGER");
    signInAs("mo");

    const { body } = await search();
    const product = body.products[0];

    expect(product).toMatchObject({
      productNumber: "OW-100",
      name: "Hartwell Sofa",
      vendorName: "Oakline Works",
      departmentName: "Upholstery",
      categoryName: "Sofas",
      baseRetail: 1980,
      baseCost: 900,
    });
    expect(product).not.toHaveProperty("vendor");
    expect(product).not.toHaveProperty("createdBy");
    const text = JSON.stringify(body);
    for (const secret of [
      "ACCT-4471",
      "Net 30",
      "oakline.example",
      "spring rate",
      "@example.com",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
