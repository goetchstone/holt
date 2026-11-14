// /app/__tests__/integration/pickerLists.integration.test.ts
//
// Pickers see every choice, not the first page. The list routes page at a
// default of 10, so a picker that asks for `?all=true` from a route without an
// `all` gets the first 10 and nothing says so:
//   - Create Variant's master-product picker asked /api/products?all=true and
//     offered 10 products. It now searches as you type, so a product past the
//     first page is found by name. The two product tests below pin the
//     route's behaviour the fix relies on (search reaches past page one; `all`
//     is ignored); they do not render the picker and pass with or without it.
//     What fails if the picker goes back to `?all=true` is
//     __tests__/allListRequestTripwire.test.ts.
//   - TaxonomyPicker asked /api/types?all=true and CategoryModal
//     /api/labels?all=true. Types and label templates are store configuration,
//     a short list, so those routes now honor `all` as departments and
//     categories already did.
//
// Real routes and database; next-auth's session is the only mock.

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
import productsRoute from "@/pages/api/products/index";
import typesRoute from "@/pages/api/types/index";
import labelsRoute from "@/pages/api/labels/index";

const sessionMock = getServerSession as jest.Mock;
const COUNT = 14; // more than any route's default page of 10

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
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  return res as unknown as TestRes;
}

async function get(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  query: Record<string, string>,
) {
  const res = makeRes();
  await route(
    { method: "GET", query, body: {}, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res,
  );
  return res;
}

const pad = (i: number) => String(i).padStart(2, "0");

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: {
      userId: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      role: "ADMIN",
      roleId: role.id,
    },
  });
  sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });

  const vendor = await prisma.vendor.create({ data: { name: "Fictional Mill" } });
  const department = await prisma.department.create({ data: { name: "Upholstery" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  for (let i = 1; i <= COUNT; i++) {
    await prisma.product.create({
      data: {
        name: `Sofa ${pad(i)}`,
        productNumber: `SOFA-${pad(i)}`,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
    await prisma.type.create({ data: { name: `Type ${pad(i)}`, categoryId: category.id } });
    await prisma.labelTemplate.create({
      data: { name: `Tag ${pad(i)}`, context: "PRODUCT", tagSize: "2x1", zplTemplate: "^XA^XZ" },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("picker lists", () => {
  it("finds a product past the first page by searching, as the master-product picker does", async () => {
    // What useProductSearch sends for "Sofa 14" with the picker's limit.
    const res = await get(productsRoute, { search: "Sofa 14", limit: "20" });

    expect(res.statusCode).toBe(200);
    expect(res.body.products.map((p: { productNumber: string }) => p.productNumber)).toEqual([
      "SOFA-14",
    ]);
    // The row carries what Create Variant reads off the chosen master.
    expect(res.body.products[0]).toMatchObject({
      vendorId: expect.any(Number),
      departmentId: expect.any(Number),
      categoryId: expect.any(Number),
      vendorName: "Fictional Mill",
    });
  });

  it("still pages products when nothing is searched (the route has no `all`)", async () => {
    const res = await get(productsRoute, { all: "true" });
    expect(res.body.products).toHaveLength(10);
    expect(res.body.total).toBe(COUNT);
  });

  it("returns every type on ?all=true, and still pages without it", async () => {
    expect((await get(typesRoute, { all: "true" })).body.types).toHaveLength(COUNT);
    expect((await get(typesRoute, {})).body.types).toHaveLength(10);
  });

  it("returns every label template on ?all=true, and still pages without it", async () => {
    expect((await get(labelsRoute, { all: "true" })).body.templates).toHaveLength(COUNT);
    expect((await get(labelsRoute, {})).body.templates).toHaveLength(10);
  });
});
