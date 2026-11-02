// /app/__tests__/integration/productSources.integration.test.ts
//
// GAP-22: an item can be bought from more than one vendor (docs/DECISIONS.md
// 31). The product screen lists its other vendors, each with that vendor's
// item number and cost; a purchase order has one vendor and may order an item
// from its own vendor or any listed one, under that vendor's number and at its
// cost (buyingTerms). Every path that puts a product on a PO asks the same
// rule: the editor's picker, saving a PO, duplicating one.
//
// Real routes, real permission gates, real database; the session readers are
// the only mocks.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import sourcesRoute from "@/pages/api/products/[id]/sources/index";
import sourceRoute from "@/pages/api/products/[id]/sources/[sourceId]";
import ordersRoute from "@/pages/api/purchasing/orders/index";
import editRoute from "@/pages/api/purchasing/orders/[id]/edit";
import duplicateRoute from "@/pages/api/purchasing/orders/[id]/duplicate";
import vendorProductsRoute from "@/pages/api/purchasing/vendor-products";
import ProductDetailPage from "@/app/(dashboard)/app/inventory/products/[id]/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
): Promise<Reply> {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown = null;
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
  await route({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload)) };
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

const w = {} as {
  fern: { id: number };
  quarry: { id: number };
  bright: { id: number };
  sofa: { id: number };
  chair: { id: number };
  lamp: { id: number };
  throw: { id: number };
  warehouse: { id: number };
};

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Co", slug: "test-co" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, companyName: "Linden Row Home", timezone: "UTC" },
  });
  invalidateAppSettingsCache();

  // An admin on file, so the bootstrap safeguard is off and each refusal is real.
  await makeStaff("ada", "ADMIN");
  await makeStaff("bea", "BUYER");
  await makeStaff("dee", "DESIGNER");
  // A custom role that edits the catalog and writes POs without seeing cost.
  await prisma.role.create({
    data: {
      key: "CATALOG_CLERK",
      name: "Catalog clerk",
      isSystem: false,
      permissions: {
        create: ["catalog.read", "catalog.write", "purchasing.read", "purchasing.write"].map(
          (permission) => ({ permission }),
        ),
      },
    },
  });
  await makeStaff("kit", "CATALOG_CLERK", "DATA_ENTRY");

  const dept = await prisma.department.create({ data: { name: "Living" } });
  const cat = await prisma.category.create({ data: { name: "Seating", departmentId: dept.id } });
  w.fern = await prisma.vendor.create({ data: { name: "Fernbrook Upholstery" } });
  w.quarry = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
  // A company that sells several lines: a vendor like any other.
  w.bright = await prisma.vendor.create({ data: { name: "Brightline Supply" } });
  const product = (vendorId: number, n: string, name: string, cost: number) =>
    prisma.product.create({
      data: {
        productNumber: n,
        name,
        vendorId,
        baseCost: cost,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
  w.sofa = await product(w.fern.id, "FB-SOFA", "Ashby Sofa", 812);
  w.chair = await product(w.fern.id, "FB-CHAIR", "Ashby Chair", 400);
  w.lamp = await product(w.quarry.id, "QH-LAMP", "Quarry Lamp", 60);
  w.throw = await product(w.bright.id, "BL-THROW", "Wool Throw", 35);
  w.warehouse = await prisma.storeLocation.create({
    data: { name: "Linden Row Warehouse", code: "WH", type: "WAREHOUSE" },
  });
});

beforeEach(async () => {
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.productSource.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const add = (productId: number, body: object, userId = "bea") =>
  call(sourcesRoute, userId, { method: "POST", query: { id: String(productId) }, body });
const list = (productId: number, userId = "bea") =>
  call(sourcesRoute, userId, { query: { id: String(productId) } });

/** The sofa sold to us by Brightline too, under its number and at its price. */
async function brightSellsSofa(over: object = {}) {
  const r = await add(w.sofa.id, {
    vendorId: w.bright.id,
    itemNumber: "BRT-5521",
    cost: 790,
    ...over,
  });
  expect(r.status).toBe(201);
  return r.body as { id: number };
}

describe("an item's other vendors, on the product screen", () => {
  it("adds one with its item number (trimmed) and cost, and lists it", async () => {
    const r = await add(w.sofa.id, {
      vendorId: w.bright.id,
      itemNumber: "  BRT-5521 ",
      cost: 790,
    });
    expect(r).toMatchObject({
      status: 201,
      body: {
        vendorId: w.bright.id,
        vendorName: "Brightline Supply",
        itemNumber: "BRT-5521",
        cost: 790,
      },
    });
    expect((await list(w.sofa.id)).body).toEqual({
      costVisible: true,
      sources: [
        {
          id: r.body.id,
          vendorId: w.bright.id,
          vendorName: "Brightline Supply",
          itemNumber: "BRT-5521",
          cost: 790,
        },
      ],
    });
    const row = await prisma.productSource.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.createdBy).toBe("bea@example.com");
  });

  it("stores a cost exactly as entered, added or changed", async () => {
    // Handed a JS number, Prisma writes 708.81 as 708.8099999999999.
    const { id } = await brightSellsSofa({ cost: 708.81 });
    const stored = async () =>
      (await prisma.productSource.findUniqueOrThrow({ where: { id } })).cost?.toString();
    expect(await stored()).toBe("708.81");
    const change = (cost: number) =>
      call(sourceRoute, "bea", {
        method: "PATCH",
        query: { id: String(w.sofa.id), sourceId: String(id) },
        body: { cost },
      });
    await change(790);
    expect(await stored()).toBe("790");
    await change(708.81);
    expect(await stored()).toBe("708.81");
  });

  it("lists them by vendor name, with a blank number or cost left blank", async () => {
    await add(w.sofa.id, { vendorId: w.quarry.id, itemNumber: "", cost: null });
    await brightSellsSofa();
    const r = await list(w.sofa.id);
    expect(
      r.body.sources.map(
        (s: { vendorName: string; itemNumber: string | null; cost: number | null }) => [
          s.vendorName,
          s.itemNumber,
          s.cost,
        ],
      ),
    ).toEqual([
      ["Brightline Supply", "BRT-5521", 790],
      ["Quarry Hill", null, null],
    ]);
  });

  it.each([
    [{ vendorId: undefined }, 400, "Choose a vendor."],
    [{ vendorId: "2" }, 400, "Choose a vendor."],
    [{ vendorId: 999_999 }, 400, "That vendor doesn't exist."],
    [{ cost: -1 }, 400, "The cost must be an amount of zero or more."],
    [{ cost: "12" }, 400, "The cost must be an amount of zero or more."],
    [{ itemNumber: 42 }, 400, "The item number must be text."],
    [{ itemNumber: "X".repeat(61) }, 400, "The item number is at most 60 characters."],
  ])("refuses %j, saying why", async (over, status, error) => {
    const r = await add(w.sofa.id, { vendorId: w.bright.id, ...over });
    expect(r).toMatchObject({ status, body: { error } });
    expect(await prisma.productSource.count()).toBe(0);
  });

  it("refuses the item's own vendor, a vendor already listed, and an item that isn't there", async () => {
    expect(await add(w.sofa.id, { vendorId: w.fern.id })).toMatchObject({
      status: 409,
      body: { error: "Fernbrook Upholstery is this item's own vendor already." },
    });
    await brightSellsSofa();
    expect(await add(w.sofa.id, { vendorId: w.bright.id })).toMatchObject({
      status: 409,
      body: { error: "Brightline Supply is already one of this item's vendors." },
    });
    expect(await add(999_999, { vendorId: w.bright.id })).toMatchObject({
      status: 404,
      body: { error: "Product not found." },
    });
    expect(await list(999_999)).toMatchObject({ status: 404 });
  });

  it("changes the item number and cost, and blank clears them", async () => {
    const { id } = await brightSellsSofa();
    const patch = (body: object, userId = "bea") =>
      call(sourceRoute, userId, {
        method: "PATCH",
        query: { id: String(w.sofa.id), sourceId: String(id) },
        body,
      });
    expect((await patch({ itemNumber: "BRT-5522", cost: 805.5 })).body).toMatchObject({
      itemNumber: "BRT-5522",
      cost: 805.5,
    });
    // A field not sent is left alone.
    expect((await patch({ cost: 800 })).body).toMatchObject({ itemNumber: "BRT-5522", cost: 800 });
    expect((await patch({ itemNumber: " ", cost: null })).body).toMatchObject({
      itemNumber: null,
      cost: null,
    });
    expect((await patch({ cost: -5 })).body).toEqual({
      error: "The cost must be an amount of zero or more.",
    });
  });

  it("changes and removes only a vendor of that item", async () => {
    const { id } = await brightSellsSofa();
    const elsewhere = { id: String(w.chair.id), sourceId: String(id) };
    expect(
      await call(sourceRoute, "bea", { method: "PATCH", query: elsewhere, body: { cost: 1 } }),
    ).toMatchObject({ status: 404, body: { error: "That vendor isn't on this item." } });
    expect(await call(sourceRoute, "bea", { method: "DELETE", query: elsewhere })).toMatchObject({
      status: 404,
    });

    const here = { id: String(w.sofa.id), sourceId: String(id) };
    expect(await call(sourceRoute, "bea", { method: "DELETE", query: here })).toMatchObject({
      status: 200,
      body: { success: true },
    });
    expect(await prisma.productSource.count()).toBe(0);
    expect(await call(sourceRoute, "bea", { method: "DELETE", query: here })).toMatchObject({
      status: 404,
    });
  });

  it("goes with its item when the item is deleted", async () => {
    const doomed = await prisma.product.create({
      data: {
        productNumber: "FB-OTTO",
        name: "Ashby Ottoman",
        vendorId: w.fern.id,
        departmentId: (await prisma.department.findFirstOrThrow()).id,
        categoryId: (await prisma.category.findFirstOrThrow()).id,
      },
    });
    expect((await add(doomed.id, { vendorId: w.bright.id })).status).toBe(201);
    await prisma.product.delete({ where: { id: doomed.id } });
    expect(await prisma.productSource.count()).toBe(0);
  });
});

describe("who may see and change an item's other vendors", () => {
  it("lets a catalog editor without View cost add one, never setting or seeing its cost", async () => {
    const r = await add(
      w.sofa.id,
      { vendorId: w.bright.id, itemNumber: "BRT-5521", cost: 1 },
      "kit",
    );
    expect(r).toMatchObject({ status: 201, body: { itemNumber: "BRT-5521" } });
    expect(r.body).not.toHaveProperty("cost");
    expect(await prisma.productSource.findFirstOrThrow()).toMatchObject({ cost: null });

    const priced = await brightSellsSofa({ vendorId: w.quarry.id });
    const patched = await call(sourceRoute, "kit", {
      method: "PATCH",
      query: { id: String(w.sofa.id), sourceId: String(priced.id) },
      body: { itemNumber: "QH-9", cost: 1 },
    });
    expect(patched.body).toEqual({
      id: priced.id,
      vendorId: w.quarry.id,
      vendorName: "Quarry Hill",
      itemNumber: "QH-9",
    });
    const kept = await prisma.productSource.findUniqueOrThrow({ where: { id: priced.id } });
    expect(Number(kept.cost)).toBe(790);

    const listed = await list(w.sofa.id, "kit");
    expect(listed.body.costVisible).toBe(false);
    expect(listed.body.sources.every((s: object) => !("cost" in s))).toBe(true);
  });

  it("lets anyone who reads the catalog see them, and only a catalog editor change them", async () => {
    const { id } = await brightSellsSofa();
    expect((await list(w.sofa.id, "dee")).status).toBe(200);
    expect((await add(w.sofa.id, { vendorId: w.quarry.id }, "dee")).status).toBe(403);
    const query = { id: String(w.sofa.id), sourceId: String(id) };
    expect((await call(sourceRoute, "dee", { method: "PATCH", query, body: {} })).status).toBe(403);
    expect((await call(sourceRoute, "dee", { method: "DELETE", query })).status).toBe(403);
  });

  it("the product page lets a catalog editor change them and anyone else only read", async () => {
    async function viewProps(userId: string) {
      (getToken as jest.Mock).mockResolvedValue({ id: userId });
      (headers as jest.Mock).mockResolvedValue(new Headers());
      (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
      const element = await ProductDetailPage({
        params: Promise.resolve({ id: String(w.sofa.id) }),
      });
      return element.props;
    }
    expect(await viewProps("bea")).toEqual({ id: String(w.sofa.id), canEdit: true });
    expect(await viewProps("dee")).toEqual({ id: String(w.sofa.id), canEdit: false });
  });
});

describe("a purchase order orders from one vendor", () => {
  const picker = (vendorId: number, search = "", userId = "bea") =>
    call(vendorProductsRoute, userId, { query: { vendorId: String(vendorId), search } });

  it("offers a vendor's own items and the items it sells us besides, at its number and cost", async () => {
    await brightSellsSofa();
    // Listed with no number or cost of its own: ordered under the item's.
    await add(w.chair.id, { vendorId: w.bright.id });
    const r = await picker(w.bright.id);
    expect(r.body).toEqual({
      costVisible: true,
      products: [
        {
          id: w.chair.id,
          name: "Ashby Chair",
          productNumber: "FB-CHAIR",
          partNo: "FB-CHAIR",
          cost: 400,
        },
        {
          id: w.sofa.id,
          name: "Ashby Sofa",
          productNumber: "FB-SOFA",
          partNo: "BRT-5521",
          cost: 790,
        },
        {
          id: w.throw.id,
          name: "Wool Throw",
          productNumber: "BL-THROW",
          partNo: "BL-THROW",
          cost: 35,
        },
      ],
    });
    // The item's own vendor still orders it under its own number and cost.
    const own = await picker(w.fern.id);
    expect(
      own.body.products.map((p: { partNo: string; cost: number }) => [p.partNo, p.cost]),
    ).toEqual([
      ["FB-CHAIR", 400],
      ["FB-SOFA", 812],
    ]);
    // A vendor that doesn't sell it never offers it.
    expect((await picker(w.quarry.id)).body.products.map((p: { id: number }) => p.id)).toEqual([
      w.lamp.id,
    ]);
  });

  it("finds an item by the number its other vendor knows it by", async () => {
    await brightSellsSofa();
    expect(
      (await picker(w.bright.id, "5521")).body.products.map((p: { id: number }) => p.id),
    ).toEqual([w.sofa.id]);
  });

  it("leaves the cost out for a buyer without View cost", async () => {
    await brightSellsSofa();
    const r = await picker(w.bright.id, "sofa", "kit");
    expect(r.body).toEqual({
      costVisible: false,
      products: [
        { id: w.sofa.id, name: "Ashby Sofa", productNumber: "FB-SOFA", partNo: "BRT-5521" },
      ],
    });
  });

  const newPo = (vendorId: number, lines: object[]) => ({
    vendorId,
    shipToLocationId: w.warehouse.id,
    expectedDelivery: null,
    notes: null,
    lines,
  });

  it("writes a line for an item its vendor sells us besides, at that vendor's number and cost", async () => {
    await brightSellsSofa();
    const r = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo(w.bright.id, [
        { productId: w.sofa.id, quantity: 2 },
        { productId: w.throw.id, quantity: 6 },
      ]),
    });
    expect(r.status).toBe(201);
    const lines = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: r.body.id },
      orderBy: { id: "asc" },
    });
    expect(lines.map((l) => [l.productId, l.partNo, Number(l.unitCost)])).toEqual([
      [w.sofa.id, "BRT-5521", 790],
      [w.throw.id, "BL-THROW", 35],
    ]);
  });

  it("refuses an item the PO's vendor doesn't sell us, and the item's own vendor still orders it", async () => {
    const refused = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo(w.bright.id, [{ productId: w.sofa.id, quantity: 1 }]),
    });
    expect(refused).toMatchObject({
      status: 400,
      body: {
        error:
          "Line 1: Brightline Supply doesn't sell us Ashby Sofa. Make it the product's vendor, or add it under the product's other vendors, first.",
      },
    });
    expect(await prisma.purchaseOrder.count()).toBe(0);

    await brightSellsSofa();
    const own = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo(w.fern.id, [{ productId: w.sofa.id, quantity: 1 }]),
    });
    expect(own.status).toBe(201);
    const line = await prisma.purchaseOrderItem.findFirstOrThrow({
      where: { purchaseOrderId: own.body.id },
    });
    expect([line.partNo, Number(line.unitCost)]).toEqual(["FB-SOFA", 812]);
  });

  it("refuses a new line on a saved PO once that vendor stops selling the item", async () => {
    const { id: sourceId } = await brightSellsSofa();
    const po = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo(w.bright.id, [{ productId: w.throw.id, quantity: 1 }]),
    });
    await call(sourceRoute, "bea", {
      method: "DELETE",
      query: { id: String(w.sofa.id), sourceId: String(sourceId) },
    });
    const line = await prisma.purchaseOrderItem.findFirstOrThrow({
      where: { purchaseOrderId: po.body.id },
    });
    const r = await call(editRoute, "bea", {
      method: "PUT",
      query: { id: String(po.body.id) },
      body: {
        shipToLocationId: w.warehouse.id,
        expectedDelivery: null,
        notes: null,
        lines: [
          { id: line.id, productId: w.throw.id, quantity: 1 },
          { productId: w.sofa.id, quantity: 1 },
        ],
      },
    });
    expect(r).toMatchObject({
      status: 400,
      body: {
        error: expect.stringContaining("Line 2: Brightline Supply doesn't sell us Ashby Sofa."),
      },
    });
  });

  it("duplicates only what the vendor still sells us, at its number", async () => {
    const sofa = await brightSellsSofa();
    await add(w.chair.id, { vendorId: w.bright.id, itemNumber: "BRT-3310", cost: 380 });
    const po = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo(w.bright.id, [
        { productId: w.sofa.id, quantity: 1 },
        { productId: w.chair.id, quantity: 2 },
      ]),
    });
    expect(po.status).toBe(201);
    await call(sourceRoute, "bea", {
      method: "DELETE",
      query: { id: String(w.sofa.id), sourceId: String(sofa.id) },
    });

    const dup = await call(duplicateRoute, "bea", {
      method: "POST",
      query: { id: String(po.body.id) },
    });
    expect(dup.status).toBe(201);
    expect(dup.body.skipped).toEqual(["Ashby Sofa: no longer sold to us by this vendor"]);
    const lines = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: dup.body.id },
    });
    expect(lines.map((l) => [l.productId, l.partNo])).toEqual([[w.chair.id, "BRT-3310"]]);
  });
});

describe("the database", () => {
  it("refuses a negative cost and a blank item number", async () => {
    const data = { productId: w.sofa.id, vendorId: w.bright.id };
    await expect(prisma.productSource.create({ data: { ...data, cost: -0.01 } })).rejects.toThrow(
      /ProductSource_cost_nonnegative/,
    );
    await expect(
      prisma.productSource.create({ data: { ...data, itemNumber: "  " } }),
    ).rejects.toThrow(/ProductSource_itemNumber_not_blank/);
  });

  it("refuses the same vendor twice on one item", async () => {
    const data = { productId: w.sofa.id, vendorId: w.bright.id };
    await prisma.productSource.create({ data });
    await expect(prisma.productSource.create({ data })).rejects.toThrow(/Unique constraint/);
  });
});
