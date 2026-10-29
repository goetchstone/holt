// /app/__tests__/integration/taxGroups.integration.test.ts
//
// GAP-04b: products and categories sell under a tax group, and a group can be
// "not taxed". GAP-04d: a quote whose customer changes is taxed as theirs.
//
// Before: every TaxRule belonged to a group but nothing tied a product to one,
// so the resolver read every rule in the district and the first one won -- an
// item the store does not tax (a service, an exempt category) was charged the
// standard rate with no way to say otherwise. And changing a quote's customer
// re-rated nothing: an exempt buyer attached to a walk-in quote paid tax.
//
// Real routes, real permission gates, real database; next-auth's session and
// the HD PDF parser are the only mocks.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("@/lib/pricing/hdProposalParser", () => ({ parseHDProposal: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { parseHDProposal } from "@/lib/pricing/hdProposalParser";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as addLine } from "@/pages/api/sales/orders/[id]/line-items";
import { handler as updateOrder } from "@/pages/api/sales/orders/[id]";
import convertRoute from "@/pages/api/proposals/[id]/convert-to-order";
import hdImportRoute from "@/pages/api/sales/import-hd-proposal";
import taxGroupsRoute from "@/pages/api/tax/groups/index";
import taxGroupRoute from "@/pages/api/tax/groups/[id]";
import categoryRoute from "@/pages/api/categories/[id]";
import productRoute from "@/pages/api/products/[id]";

const sessionMock = getServerSession as jest.Mock;
const parseMock = parseHDProposal as jest.Mock;
const register = { user: { email: "register@example.com" } } as unknown as Session;

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

function req(method: string, query: Record<string, string> = {}, body: unknown = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method, query, body, cookies: {}, headers: {} } as any;
}

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, method: string, query = {}, body: unknown = {}) {
  const res = makeRes();
  await route(req(method, query, body), res);
  return res;
}

async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: roleKey as any, roleId: role.id },
  });
}

async function makeCustomRoleStaff(userId: string, permissions: string[]) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${userId.toUpperCase()}`,
      name: userId,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  // A role written straight to the database must drop the cached grant table,
  // as the app's own role writes do.
  invalidateRoleGrantCache();
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

/**
 * A store taxed at 6% (Standard group). A "Services" group the store does not
 * tax, and a "Clothing" group with its own band: 0% to $175, 6% above.
 */
async function setup() {
  const district = await prisma.taxDistrict.create({
    data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
  });
  const standard = await prisma.taxGroup.create({ data: { name: "Standard" } });
  const services = await prisma.taxGroup.create({ data: { name: "Services", exempt: true } });
  const clothing = await prisma.taxGroup.create({ data: { name: "Clothing" } });
  const unruled = await prisma.taxGroup.create({ data: { name: "No Rule Here" } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: standard.id, taxRate: 0.06, sortOrder: 0 },
  });
  await prisma.taxRule.create({
    data: {
      districtId: district.id,
      groupId: clothing.id,
      taxRate: 0,
      stopPrice: 175,
      sortOrder: 1,
    },
  });
  await prisma.taxRule.create({
    data: {
      districtId: district.id,
      groupId: clothing.id,
      taxRate: 0.06,
      startPrice: 175.01,
      sortOrder: 2,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE", taxDistrictId: district.id },
  });
  await prisma.appSettings.update({
    where: { organizationId: DEFAULT_ORG_ID },
    data: { defaultTaxDistrictId: district.id },
  });
  invalidateAppSettingsCache();
  const vendor = await prisma.vendor.create({
    data: { name: "Test Vendor", pricingModel: "FLAT" },
  });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const furniture = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id },
  });
  const labor = await prisma.category.create({
    data: { name: "Assembly", departmentId: dept.id, taxGroupId: services.id },
  });
  const product = (number: string, categoryId: number, taxGroupId: number | null = null) =>
    prisma.product.create({
      data: {
        productNumber: number,
        name: number,
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId,
        taxGroupId,
        baseRetail: 100,
      },
    });
  return {
    store,
    district,
    groups: { standard, services, clothing, unruled },
    categories: { furniture, labor },
    product,
  };
}

/** Ring a cart at the register's own route; return each line's vatRate in order. */
async function ring(
  storeName: string,
  items: { productId: number; unitPrice: number }[],
  customerId?: number,
) {
  const res = makeRes();
  await createFromCart(
    req(
      "POST",
      {},
      {
        storeLocation: storeName,
        customerId,
        items: items.map((i) => ({ ...i, quantity: 1 })),
      },
    ),
    res,
    register,
  );
  expect(res.statusCode).toBe(201);
  const id = (res.body as { id: number }).id;
  const lines = await prisma.orderLineItem.findMany({
    where: { salesOrderId: id },
    orderBy: { lineNumber: "asc" },
    select: { vatRate: true, vatAmount: true },
  });
  return {
    id,
    rates: lines.map((l) => Number(l.vatRate)),
    vat: lines.map((l) => Number(l.vatAmount)),
  };
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  parseMock.mockReset();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  await makeStaff("boss", "ADMIN");
  signInAs("boss");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a line is taxed under its product's tax group", () => {
  it("a category the store does not tax is 0% at the register, beside a taxed sofa", async () => {
    const { store, categories, product } = await setup();
    const sofa = await product("SOFA", categories.furniture.id);
    const assembly = await product("ASSEMBLY", categories.labor.id);

    const sale = await ring(store.name, [
      { productId: sofa.id, unitPrice: 1000 },
      { productId: assembly.id, unitPrice: 150 },
    ]);
    expect(sale.rates).toEqual([0.06, 0]);
    expect(sale.vat).toEqual([60, 0]);
  });

  it("a product's own group overrides its category's, in both directions", async () => {
    const { store, categories, groups, product } = await setup();
    const exemptSofa = await product("SOFA-X", categories.furniture.id, groups.services.id);
    const taxedService = await product("WHITE-GLOVE", categories.labor.id, groups.standard.id);

    const sale = await ring(store.name, [
      { productId: exemptSofa.id, unitPrice: 1000 },
      { productId: taxedService.id, unitPrice: 100 },
    ]);
    expect(sale.rates).toEqual([0, 0.06]);
  });

  it("a group with its own rules uses them, bands included", async () => {
    const { store, categories, groups, product } = await setup();
    const shirt = await product("SHIRT", categories.furniture.id, groups.clothing.id);

    expect((await ring(store.name, [{ productId: shirt.id, unitPrice: 120 }])).rates).toEqual([0]);
    expect((await ring(store.name, [{ productId: shirt.id, unitPrice: 300 }])).rates).toEqual([
      0.06,
    ]);
  });

  it("a taxed group the district has no rule for is taxed by the district's rules, never 0%", async () => {
    const { store, categories, groups, product } = await setup();
    const item = await product("ODD", categories.furniture.id, groups.unruled.id);
    expect((await ring(store.name, [{ productId: item.id, unitPrice: 100 }])).rates).toEqual([
      0.06,
    ]);
  });

  it("a custom line keeps its source product's group on the product it mints", async () => {
    const { store, categories, groups, product } = await setup();
    const source = await product("SVC-SRC", categories.furniture.id, groups.services.id);
    const res = makeRes();
    await createFromCart(
      req(
        "POST",
        {},
        {
          storeLocation: store.name,
          items: [
            {
              type: "CUSTOM",
              productId: source.id,
              name: "Custom assembly",
              quantity: 1,
              unitPrice: 80,
            },
          ],
        },
      ),
      res,
      register,
    );
    expect(res.statusCode).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: res.body.id },
      select: { vatRate: true, product: { select: { id: true, taxGroupId: true } } },
    });
    expect(Number(line.vatRate)).toBe(0);
    expect(line.product?.id).not.toBe(source.id);
    expect(line.product?.taxGroupId).toBe(groups.services.id);
  });

  it("a line added to an existing order is taxed under its product's group", async () => {
    const { store, categories, product } = await setup();
    const sofa = await product("SOFA", categories.furniture.id);
    const assembly = await product("ASSEMBLY", categories.labor.id);
    const sale = await ring(store.name, [{ productId: sofa.id, unitPrice: 1000 }]);

    const res = makeRes();
    await addLine(
      req(
        "POST",
        { id: String(sale.id) },
        {
          productId: assembly.id,
          productName: "Assembly",
          quantity: 1,
          unitPrice: 150,
        },
      ),
      res,
      register,
    );
    expect(res.statusCode).toBe(201);
    const added = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: sale.id, productId: assembly.id },
    });
    expect(Number(added.vatAmount)).toBe(0);
  });

  it("a converted B2B proposal taxes each line under its product's group", async () => {
    const { categories, product } = await setup();
    const sofa = await product("SOFA", categories.furniture.id);
    const assembly = await product("ASSEMBLY", categories.labor.id);
    const proposal = await prisma.proposal.create({
      data: {
        proposalNumber: "PR-0001",
        lineItems: {
          create: [
            { productId: sofa.id, itemName: "Sofa", cost: 400, retailPrice: 1000, sortOrder: 0 },
            {
              productId: assembly.id,
              itemName: "Assembly",
              cost: 0,
              retailPrice: 150,
              sortOrder: 1,
            },
            { itemName: "Fabric (free text)", cost: 10, retailPrice: 50, sortOrder: 2 },
          ],
        },
      },
    });

    expect((await call(convertRoute, "POST", { id: String(proposal.id) })).statusCode).toBe(201);
    const lines = await prisma.orderLineItem.findMany({
      orderBy: { lineNumber: "asc" },
      select: { vatAmount: true },
    });
    expect(lines.map((l) => Number(l.vatAmount))).toEqual([60, 0, 3]);
  });

  it("an HD import's item lines sell under the Blinds & Shades category's group", async () => {
    const { groups } = await setup();
    const dept = await prisma.department.create({ data: { name: "Window Treatments" } });
    await prisma.category.create({
      data: { name: "Blinds & Shades", departmentId: dept.id, taxGroupId: groups.services.id },
    });
    parseMock.mockResolvedValue({
      quoteNumber: "77002",
      quoteDate: "",
      validThrough: "",
      salesperson: "",
      sidemark: "",
      customer: { name: "Dana Reed", street: "", cityStateZip: "" },
      items: [
        {
          itemNumber: 1,
          room: "",
          description: "Shade",
          qty: 1,
          msrp: 500,
          each: 500,
          extended: 500,
          freight: 0,
          install: 0,
        },
      ],
      totalFreight: 0,
      totalInstall: 0,
      msrpTotal: 500,
      discountTotal: 0,
      clientPrice: 500,
    });

    const res = await call(
      hdImportRoute,
      "POST",
      {},
      { pdfBase64: Buffer.from("x").toString("base64") },
    );
    expect(res.statusCode).toBe(200);
    const line = await prisma.orderLineItem.findFirstOrThrow({ where: { partNo: "HD-77002-1" } });
    expect(Number(line.vatAmount)).toBe(0);
  });
});

describe("tax groups are set up in Admin, and chosen on categories and products", () => {
  it("a group is created not taxed, and the category and product editors can read the list", async () => {
    const created = await call(taxGroupsRoute, "POST", {}, { name: "Services", exempt: true });
    expect(created.statusCode).toBe(201);
    expect(created.body.exempt).toBe(true);

    await makeCustomRoleStaff("cat", ["catalog.write"]);
    signInAs("cat");
    const list = await call(taxGroupsRoute, "GET");
    expect(list.statusCode).toBe(200);
    expect(list.body.map((g: { name: string; exempt: boolean }) => [g.name, g.exempt])).toEqual([
      ["Services", true],
    ]);
    expect((await call(taxGroupsRoute, "POST", {}, { name: "Other" })).statusCode).toBe(403);

    await makeCustomRoleStaff("nobody", ["sales.read"]);
    signInAs("nobody");
    expect((await call(taxGroupsRoute, "GET")).statusCode).toBe(403);
  });

  it("a category's group is set, refused when it names no group, and left alone when not sent", async () => {
    const { categories, groups } = await setup();
    const id = String(categories.furniture.id);
    const base = { name: "Sofas", departmentId: categories.furniture.departmentId };

    expect(
      (await call(categoryRoute, "PUT", { id }, { ...base, taxGroupId: groups.services.id }))
        .statusCode,
    ).toBe(200);
    const missing = await call(categoryRoute, "PUT", { id }, { ...base, taxGroupId: 999999 });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toBe("Tax group not found");
    expect((await call(categoryRoute, "PUT", { id }, base)).statusCode).toBe(200);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id: Number(id) } })).taxGroupId,
    ).toBe(groups.services.id);
    expect(
      (await call(categoryRoute, "PUT", { id }, { ...base, taxGroupId: null })).statusCode,
    ).toBe(200);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id: Number(id) } })).taxGroupId,
    ).toBeNull();
  });

  it("a product's own group is set and cleared, and its detail shows its category's", async () => {
    const { categories, groups, product } = await setup();
    const assembly = await product("ASSEMBLY", categories.labor.id);
    const id = String(assembly.id);

    expect(
      (await call(productRoute, "PATCH", { id }, { taxGroupId: groups.standard.id })).statusCode,
    ).toBe(200);
    let detail = await call(productRoute, "GET", { id });
    expect(detail.body.taxGroupId).toBe(groups.standard.id);
    expect(detail.body.category.taxGroup.name).toBe("Services");

    expect((await call(productRoute, "PATCH", { id }, { taxGroupId: null })).statusCode).toBe(200);
    detail = await call(productRoute, "GET", { id });
    expect(detail.body.taxGroupId).toBeNull();
  });

  it("a group still chosen by a category or product cannot be deleted", async () => {
    const { groups } = await setup();
    const res = await call(taxGroupRoute, "DELETE", { id: String(groups.services.id) });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("Cannot delete: 1 category and 0 products sell under this group.");
    expect(await prisma.taxGroup.count({ where: { id: groups.services.id } })).toBe(1);
  });
});

describe("a quote whose customer changes is taxed as theirs (GAP-04d)", () => {
  async function quoteFor(customerId?: number) {
    const s = await setup();
    const sofa = await s.product("SOFA", s.categories.furniture.id);
    const assembly = await s.product("ASSEMBLY", s.categories.labor.id);
    const sale = await ring(
      s.store.name,
      [
        { productId: sofa.id, unitPrice: 1000 },
        { productId: assembly.id, unitPrice: 150 },
      ],
      customerId,
    );
    return { ...s, sale };
  }

  async function changeCustomer(orderId: number, customerId: number | null) {
    const res = makeRes();
    await updateOrder(req("PUT", { id: String(orderId) }, { customerId }), res, register);
    expect(res.statusCode).toBe(200);
    return prisma.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { lineItems: { orderBy: { lineNumber: "asc" }, select: { vatAmount: true } } },
    });
  }

  it("an exempt buyer attached to a walk-in quote is re-rated to 0% with the reason; detaching taxes it again", async () => {
    const { sale } = await quoteFor();
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const buyer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed", taxExemptReasonId: resale.id },
    });

    const exempt = await changeCustomer(sale.id, buyer.id);
    expect(exempt.taxExemptReasonId).toBe(resale.id);
    expect(exempt.lineItems.map((l) => Number(l.vatAmount))).toEqual([0, 0]);
    expect(Number(exempt.totalTax)).toBe(0);

    const walkIn = await changeCustomer(sale.id, null);
    expect(walkIn.taxExemptReasonId).toBeNull();
    // The not-taxed group still holds on the assembly line.
    expect(walkIn.lineItems.map((l) => Number(l.vatAmount))).toEqual([60, 0]);
    expect(Number(walkIn.totalTax)).toBe(60);
  });

  it("a quote money has touched keeps the tax it was charged", async () => {
    const { sale } = await quoteFor();
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const buyer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed", taxExemptReasonId: resale.id },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: sale.id,
        paymentDate: new Date(),
        paymentType: "Card",
        paymentAmount: 100,
      },
    });

    const kept = await changeCustomer(sale.id, buyer.id);
    expect(kept.customerId).toBe(buyer.id);
    expect(kept.taxExemptReasonId).toBeNull();
    expect(kept.lineItems.map((l) => Number(l.vatAmount))).toEqual([60, 0]);
  });
});
