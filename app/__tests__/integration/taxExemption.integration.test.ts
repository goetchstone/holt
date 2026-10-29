// /app/__tests__/integration/taxExemption.integration.test.ts
//
// GAP-04a: a customer's sales-tax exemption is one column staff can set, and
// every sale records it.
//
// Before: Customer.taxExempt (boolean) and Customer.taxExemptReasonId answered
// the same question, the register and quotes read one and B2B proposals the
// other, and no route wrote either -- so staff could not exempt anyone. The
// routes that create orders charged an exempt customer 0% but never wrote the
// reason on the order, and Tax Summary checked the district before the reason,
// so an exempt sale was filed as a $0 taxable one in its district.
//
// Real routes, real permission gates, real database. next-auth's session and
// the HD PDF parser are the only mocks: the parser is not under test, the
// order it feeds is.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("@/lib/pricing/hdProposalParser", () => ({ parseHDProposal: jest.fn() }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { parseHDProposal, type HDProposal } from "@/lib/pricing/hdProposalParser";
import { getTaxSummary } from "@/lib/reports/taxSummary";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import tradeRoute from "@/pages/api/customers/[id]/trade";
import exemptReasonsRoute from "@/pages/api/tax/exempt-reasons/index";
import convertRoute from "@/pages/api/proposals/[id]/convert-to-order";
import hdImportRoute from "@/pages/api/sales/import-hd-proposal";

const sessionMock = getServerSession as jest.Mock;
const parseMock = parseHDProposal as jest.Mock;

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "../../prisma/migrations/20261029120000_customer_tax_exemption_one_column/migration.sql",
  ),
  "utf8",
);

const TAX_RATE = 0.06;

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

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(
  route: Route,
  method: string,
  query: Record<string, string> = {},
  body: unknown = {},
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method, query, body, cookies: {}, headers: {} } as any;
  await route(req, res);
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
  // The grant table is cached; the app's own role writes invalidate it, and a
  // row written straight to the database must too, or the new role is unknown
  // and the staff row's DESIGNER grants answer instead.
  invalidateRoleGrantCache();
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

/** A store taxed at 6%, set as the deployment default too, and one product. */
async function storeAndProduct() {
  const vendor = await prisma.vendor.create({
    data: { name: "Test Vendor", pricingModel: "FLAT" },
  });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const district = await prisma.taxDistrict.create({
    data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
  });
  const group = await prisma.taxGroup.create({ data: { name: "Standard Retail" } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: group.id, taxRate: TAX_RATE, sortOrder: 0 },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE", taxDistrictId: district.id },
  });
  await prisma.appSettings.update({
    where: { organizationId: DEFAULT_ORG_ID },
    data: { defaultTaxDistrictId: district.id },
  });
  invalidateAppSettingsCache();
  const product = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Test Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
      baseRetail: 1000,
    },
  });
  return { store, product, district };
}

/** Ring a $1,000 sale for the customer at the register's own route. */
async function ringSale(storeName: string, productId: number, customerId: number) {
  const res = makeRes();
  await createFromCart(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      method: "POST",
      query: {},
      body: {
        storeLocation: storeName,
        customerId,
        items: [{ productId, quantity: 1, unitPrice: 1000 }],
      },
    } as any,
    res,
    { user: { email: "register@example.com" } } as unknown as Session,
  );
  expect(res.statusCode).toBe(201);
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: (res.body as { id: number }).id },
    include: { lineItems: { select: { vatRate: true, vatAmount: true } } },
  });
  return order;
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

describe("staff set a customer's exemption, and every sale records it", () => {
  it("a reason set on the customer screen makes the next register sale exempt, with the reason on the order", async () => {
    const { store, product } = await storeAndProduct();
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed" },
    });

    const put = await call(
      tradeRoute,
      "PUT",
      { id: String(customer.id) },
      {
        taxExemptReasonId: resale.id,
        taxExemptNumber: "EX-1234",
      },
    );
    expect(put.statusCode).toBe(200);
    expect(put.body.taxExemptReason.name).toBe("Resale");

    const order = await ringSale(store.name, product.id, customer.id);
    expect(order.taxExemptReasonId).toBe(resale.id);
    expect(order.lineItems.map((l) => Number(l.vatRate))).toEqual([0]);
    expect(order.lineItems.map((l) => Number(l.vatAmount))).toEqual([0]);
  });

  it("clearing it taxes the next sale, and the order sold while exempt keeps its exemption", async () => {
    const { store, product } = await storeAndProduct();
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed", taxExemptReasonId: resale.id },
    });
    const exemptSale = await ringSale(store.name, product.id, customer.id);

    const put = await call(
      tradeRoute,
      "PUT",
      { id: String(customer.id) },
      { taxExemptReasonId: null },
    );
    expect(put.statusCode).toBe(200);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).taxExemptReasonId,
    ).toBeNull();

    const taxedSale = await ringSale(store.name, product.id, customer.id);
    expect(taxedSale.taxExemptReasonId).toBeNull();
    expect(taxedSale.lineItems.map((l) => Number(l.vatAmount))).toEqual([60]);
    expect(
      (await prisma.salesOrder.findUniqueOrThrow({ where: { id: exemptSale.id } }))
        .taxExemptReasonId,
    ).toBe(resale.id);
  });

  it("refuses a reason that does not exist, or is not an id, and changes nothing", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed" },
    });

    const missing = await call(
      tradeRoute,
      "PUT",
      { id: String(customer.id) },
      { taxExemptReasonId: 999999 },
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toBe("Tax exempt reason not found");

    const notAnId = await call(
      tradeRoute,
      "PUT",
      { id: String(customer.id) },
      { taxExemptReasonId: "Resale" },
    );
    expect(notAnId.statusCode).toBe(400);
    expect(notAnId.body.error).toBe("Tax exempt reason must be a reason id");

    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).taxExemptReasonId,
    ).toBeNull();
  });

  it("only a manager or admin may change it", async () => {
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed" },
    });
    await makeStaff("pat", "DESIGNER");
    signInAs("pat");

    const put = await call(
      tradeRoute,
      "PUT",
      { id: String(customer.id) },
      { taxExemptReasonId: resale.id },
    );
    expect(put.statusCode).toBe(403);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).taxExemptReasonId,
    ).toBeNull();
  });

  it("the customer screen's picker lists reasons for anyone who can view customers; adding one stays an admin setting", async () => {
    await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    await makeCustomRoleStaff("kim", ["customer.read"]);
    signInAs("kim");

    const list = await call(exemptReasonsRoute, "GET");
    expect(list.statusCode).toBe(200);
    expect(list.body.map((r: { name: string }) => r.name)).toEqual(["Resale"]);

    const add = await call(exemptReasonsRoute, "POST", {}, { name: "Non-Profit" });
    expect(add.statusCode).toBe(403);
    expect(await prisma.taxExemptReason.count()).toBe(1);

    await makeCustomRoleStaff("lee", ["catalog.read"]);
    signInAs("lee");
    expect((await call(exemptReasonsRoute, "GET")).statusCode).toBe(403);
  });

  it("a converted B2B proposal is exempt and records the reason", async () => {
    await storeAndProduct();
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed", taxExemptReasonId: resale.id },
    });
    const proposal = await prisma.proposal.create({
      data: {
        proposalNumber: "PR-0001",
        customerId: customer.id,
        lineItems: {
          create: [{ itemName: "Belgian Linen", cost: 8, retailPrice: 30, quantity: 10 }],
        },
      },
    });

    const res = await call(convertRoute, "POST", { id: String(proposal.id) });
    expect(res.statusCode).toBe(201);
    const order = await prisma.salesOrder.findFirstOrThrow({
      where: { customerId: customer.id },
      include: { lineItems: { select: { vatAmount: true } } },
    });
    expect(order.taxExemptReasonId).toBe(resale.id);
    expect(order.lineItems.map((l) => Number(l.vatAmount))).toEqual([0]);
  });

  it("an HD proposal import records the customer's exemption, and a re-import follows a change to it", async () => {
    await storeAndProduct();
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed", taxExemptReasonId: resale.id },
    });
    const proposal: HDProposal = {
      quoteNumber: "77001",
      quoteDate: "10/29/2026",
      validThrough: "11/29/2026",
      salesperson: "",
      sidemark: "",
      customer: { name: "Dana Reed", street: "", cityStateZip: "" },
      items: [
        {
          itemNumber: 1,
          room: "Living",
          description: "Sofa",
          qty: 1,
          msrp: 1000,
          each: 1000,
          extended: 1000,
          freight: 0,
          install: 0,
        },
      ],
      totalFreight: 0,
      totalInstall: 0,
      msrpTotal: 1000,
      discountTotal: 0,
      clientPrice: 1000,
    };
    parseMock.mockResolvedValue(proposal);
    const pdfBase64 = Buffer.from("not parsed").toString("base64");

    expect((await call(hdImportRoute, "POST", {}, { pdfBase64 })).statusCode).toBe(200);
    const first = await prisma.salesOrder.findUniqueOrThrow({
      where: { orderno: "HD-77001" },
      include: { lineItems: { select: { vatAmount: true, productName: true } } },
    });
    expect(first.customerId).toBe(customer.id);
    expect(first.taxExemptReasonId).toBe(resale.id);
    expect(first.lineItems.every((l) => Number(l.vatAmount) === 0)).toBe(true);

    await prisma.customer.update({ where: { id: customer.id }, data: { taxExemptReasonId: null } });
    expect((await call(hdImportRoute, "POST", {}, { pdfBase64 })).statusCode).toBe(200);
    const again = await prisma.salesOrder.findUniqueOrThrow({
      where: { orderno: "HD-77001" },
      include: { lineItems: { select: { vatAmount: true } } },
    });
    expect(again.taxExemptReasonId).toBeNull();
    expect(again.lineItems.some((l) => Number(l.vatAmount) > 0)).toBe(true);
  });
});

describe("Tax Summary files an exempt sale under its reason", () => {
  it("not under the district it would have been taxed in", async () => {
    const district = await prisma.taxDistrict.create({
      data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
    });
    const group = await prisma.taxGroup.create({ data: { name: "Standard Retail" } });
    await prisma.taxRule.create({
      data: { districtId: district.id, groupId: group.id, taxRate: TAX_RATE, sortOrder: 0 },
    });
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const day = new Date("2026-10-15T15:00:00.000Z");

    // The resolver records the district on an exempt order too, so both carry it.
    const taxed = await prisma.salesOrder.create({
      data: { orderno: "T-1", status: "ORDER", orderDate: day, taxDistrictId: district.id },
    });
    const exempt = await prisma.salesOrder.create({
      data: {
        orderno: "T-2",
        status: "ORDER",
        orderDate: day,
        taxDistrictId: district.id,
        taxExemptReasonId: resale.id,
      },
    });
    await prisma.invoice.create({
      data: { invoiceNo: "INV-1", invoiceDate: day, taxAmount: 60, salesOrderId: taxed.id },
    });
    await prisma.invoice.create({
      data: { invoiceNo: "INV-2", invoiceDate: day, taxAmount: 0, salesOrderId: exempt.id },
    });

    const summary = await getTaxSummary(prisma, { startDate: "2026-10-01", endDate: "2026-10-31" });
    const byKey = Object.fromEntries(
      summary.byJurisdiction.map((j) => [
        j.jurisdiction,
        { tax: j.taxCollected, n: j.invoiceCount },
      ]),
    );
    expect(byKey).toEqual({
      "ST 6.00%": { tax: 60, n: 1 },
      "Exempt - Resale": { tax: 0, n: 1 },
    });
  });
});

describe("migration 20261029120000 drops the boolean only when nothing is lost", () => {
  afterEach(async () => {
    // The test DB is pushed from the branch schema, which has no such column.
    // Put it back exactly as the schema has it, whatever the test did.
    await prisma.$executeRawUnsafe(`ALTER TABLE "Customer" DROP COLUMN IF EXISTS "taxExempt"`);
  });

  async function hasColumn(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.columns
       WHERE table_name = 'Customer' AND column_name = 'taxExempt'`,
    );
    return Number(rows[0].n) === 1;
  }

  it("refuses while a customer is exempt by the flag alone, then drops the column once each has a reason", async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Customer" ADD COLUMN "taxExempt" BOOLEAN NOT NULL DEFAULT false`,
    );
    const flagOnly = await prisma.customer.create({
      data: { firstName: "Flag", lastName: "Only" },
    });
    const both = await prisma.customer.create({ data: { firstName: "Both", lastName: "Set" } });
    const resale = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    await prisma.customer.update({
      where: { id: both.id },
      data: { taxExemptReasonId: resale.id },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Customer" SET "taxExempt" = true WHERE id IN (${flagOnly.id}, ${both.id})`,
    );

    await expect(prisma.$executeRawUnsafe(MIGRATION_SQL)).rejects.toThrow(
      /1 customer\(s\) have Customer\.taxExempt = true but no taxExemptReasonId/,
    );
    expect(await hasColumn()).toBe(true);

    await prisma.customer.update({
      where: { id: flagOnly.id },
      data: { taxExemptReasonId: resale.id },
    });
    await prisma.$executeRawUnsafe(MIGRATION_SQL);
    expect(await hasColumn()).toBe(false);
    expect(
      (await prisma.customer.findMany({ select: { taxExemptReasonId: true } })).map(
        (c) => c.taxExemptReasonId,
      ),
    ).toEqual([resale.id, resale.id]);
  });
});
