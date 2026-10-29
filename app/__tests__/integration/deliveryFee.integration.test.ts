// /app/__tests__/integration/deliveryFee.integration.test.ts
//
// GAP-09: an order charges its delivery zone's fee.
//
// Before: DeliveryZone.baseFee and perPieceFee were stored and shown on the
// zones screen, and nothing put them on an order. A store charged delivery by
// typing a line by hand, which sales credit counted as a sale unless it was
// named exactly "Delivery Charge", and which the journal booked to no account.
//
// Real routes, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { buildLineItemWhere } from "@/lib/salesBySalesperson";
import { rerateQuoteTax } from "@/lib/tax/rerateQuoteTax";
import { generateSalesJournal } from "@/lib/journalEntry";
import { businessDayKey } from "@/lib/reports/businessDay";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as feeRoute } from "@/pages/api/sales/orders/[id]/delivery-fee";
import { handler as quoteRoute } from "@/pages/api/sales/delivery-fee-quote";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import returnsRoute from "@/pages/api/returns/index";
import taxGroupRoute from "@/pages/api/tax/groups/[id]";
import settingsRoute from "@/pages/api/admin/settings/index";
import exchangeRoute from "@/pages/api/returns/[id]/exchange";
import { handler as addLine } from "@/pages/api/sales/orders/[id]/line-items";
import { handler as orderRoute } from "@/pages/api/sales/orders/[id]";

const sessionMock = getServerSession as jest.Mock;
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

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => unknown;
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function asRegister(handler: Handler, method: string, query = {}, body: unknown = {}) {
  const res = makeRes();
  await handler(req(method, query, body), res, register);
  return res;
}

async function signedIn(route: Route, method: string, query = {}, body: unknown = {}) {
  const res = makeRes();
  await route(req(method, query, body), res);
  return res;
}

/**
 * A store taxed at 6%, a "Not taxed" group, one active zone (Local: $79 plus
 * $15 a piece) and one switched-off zone, a customer in the Local zone, a sofa,
 * and the GL accounts a delivered order books to.
 */
async function world(opts: { feeMapped?: boolean } = {}) {
  const gl = (code: string, name: string, accountType: string) =>
    prisma.gLAccount.create({ data: { code, name, accountType } });
  const cash = await gl("1-1006", "Cash", "ASSET");
  const deposit = await gl("2-2200", "Customer Deposits", "LIABILITY");
  const ar = await gl("1-1100", "Accounts Receivable", "ASSET");
  const sales = await gl("4-4080", "Furniture Sales", "REVENUE");
  const cogs = await gl("5-5280", "Furniture COGS", "EXPENSE");
  const inventory = await gl("1-1380", "Furniture Inventory", "ASSET");
  const taxGl = await gl("2-2120", "Sales Tax Payable", "LIABILITY");
  const overShort = await gl("5-5900", "Over/Short", "EXPENSE");
  const deliveryIncome = await gl("4-4960", "Delivery Fees", "REVENUE");
  const map = (section: string, label: string, glAccountId: number | null) =>
    prisma.systemGLMapping.create({ data: { section, label, glAccountId } });
  await map("POS_PAYMENTS", "Cash", cash.id);
  await map("POS_PAYMENTS", "On Account", deposit.id);
  await map("AR_TRANSACTIONS", "Accounts Receivable", ar.id);
  await map("POS_TRANSACTIONS", "Sales Tax", taxGl.id);
  await map("POS_TRANSACTIONS", "Over/Short", overShort.id);
  await map(
    "POS_TRANSACTIONS",
    "Delivery Fee",
    opts.feeMapped === false ? null : deliveryIncome.id,
  );

  const district = await prisma.taxDistrict.create({
    data: {
      shortName: "ST",
      state: "MI",
      name: "State Sales Tax",
      isActive: true,
      glAccountId: taxGl.id,
    },
  });
  const standard = await prisma.taxGroup.create({ data: { name: "Standard" } });
  const notTaxed = await prisma.taxGroup.create({ data: { name: "Not taxed", exempt: true } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: standard.id, taxRate: 0.06, sortOrder: 0 },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE", taxDistrictId: district.id },
  });

  const local = await prisma.deliveryZone.create({
    data: {
      name: "Local",
      baseFee: 79,
      perPieceFee: 15,
      zipCodes: { create: [{ zipCode: "06880" }] },
    },
  });
  await prisma.deliveryZone.create({
    data: {
      name: "Retired",
      baseFee: 10,
      isActive: false,
      zipCodes: { create: [{ zipCode: "06881" }] },
    },
  });

  const customer = await prisma.customer.create({
    data: {
      firstName: "Ada",
      lastName: "Lane",
      addresses: {
        create: [{ address1: "1 Main St", city: "Westport", state: "CT", zip: "06880-1234" }],
      },
    },
  });

  const group = await prisma.accountGroup.create({
    data: {
      name: "Furniture",
      salesAccountId: sales.id,
      cogsAccountId: cogs.id,
      inventoryAccountId: inventory.id,
    },
  });
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, accountGroupId: group.id },
  });
  const sofa = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Camelback Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseRetail: 1000,
    },
  });
  return {
    store,
    customer,
    sofa,
    local,
    groups: { standard, notTaxed },
    gl: { cash, deliveryIncome, overShort, sales, taxGl },
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function signInAdmin() {
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "boss", email: "boss@example.com" } });
  const admin = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "boss", displayName: "boss", role: "ADMIN", roleId: admin.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "boss", email: "boss@example.com" } });
}

/** Two sofas at the register, going out by delivery, with this fee. */
async function ringDelivery(w: World, deliveryFee?: number) {
  return asRegister(
    createFromCart,
    "POST",
    {},
    {
      storeLocation: w.store.name,
      customerId: w.customer.id,
      deliveryMethod: "DELIVERY",
      deliveryFee,
      items: [{ productId: w.sofa.id, quantity: 2, unitPrice: 1000 }],
    },
  );
}

async function feeLineOf(orderId: number) {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { totalTax: true, deliveryFeeLine: true },
  });
  return { line: order.deliveryFeeLine, totalTax: Number(order.totalTax) };
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("what the zone charges", () => {
  it("prices the customer's zone for the sale's pieces, by the ZIP's first five digits", async () => {
    const w = await world();
    const res = await asRegister(quoteRoute, "GET", {
      customerId: String(w.customer.id),
      pieces: "2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      zip: "06880-1234",
      zone: { id: w.local.id, name: "Local" },
      pieces: 2,
      amount: 109,
    });
  });

  it("a switched-off zone delivers nowhere", async () => {
    await world();
    const res = await asRegister(quoteRoute, "GET", { zip: "06881", pieces: "1" });
    expect(res.body).toMatchObject({ zip: "06881", zone: null, amount: null });
  });
});

describe("the register charges delivery", () => {
  it("as a line of its own: no product, taxed, in the order's total and tax", async () => {
    const w = await world();
    const res = await ringDelivery(w, 109);
    expect(res.statusCode).toBe(201);
    // Sofas 2,000 + tax 120; delivery 109 + tax 6.54.
    expect(res.body).toMatchObject({ deliveryFee: 109, taxAmount: 126.54, total: 2235.54 });

    const { line, totalTax } = await feeLineOf(res.body.id);
    expect(line).toMatchObject({ productId: null, productName: "Delivery — Local" });
    expect([
      Number(line?.netPrice),
      Number(line?.vatAmount),
      Number(line?.orderedQuantity),
    ]).toEqual([109, 6.54, 1]);
    expect(totalTax).toBe(126.54);
  });

  it("under the store's delivery tax group: not taxed where delivery isn't, even re-rated", async () => {
    const w = await world();
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { deliveryFeeTaxGroupId: w.groups.notTaxed.id },
    });
    const res = await ringDelivery(w, 109);
    expect(res.body).toMatchObject({ taxAmount: 120, total: 2229 });
    expect(Number((await feeLineOf(res.body.id)).line?.vatAmount)).toBe(0);

    // A quote re-rated when its customer changes keeps delivery untaxed and
    // the sofas taxed (rerateQuoteTax, GAP-04d).
    await rerateQuoteTax(prisma, res.body.id);
    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrderId: res.body.id },
      orderBy: { lineNumber: "asc" },
      select: { vatAmount: true },
    });
    expect(lines.map((l) => Number(l.vatAmount))).toEqual([120, 0]);
  });

  it("refuses a fee while Delivery Fee has no income account, and writes no order", async () => {
    const w = await world({ feeMapped: false });
    const res = await ringDelivery(w, 109);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('map "Delivery Fee"');
    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("refuses a fee on a sale that isn't going out by delivery", async () => {
    const w = await world();
    const res = await asRegister(
      createFromCart,
      "POST",
      {},
      {
        storeLocation: w.store.name,
        deliveryMethod: "PICKUP",
        deliveryFee: 50,
        items: [{ productId: w.sofa.id, quantity: 1, unitPrice: 1000 }],
      },
    );
    expect(res.statusCode).toBe(400);
    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("the order screen's delivery fee", () => {
  it("charges the zone's fee, changes it, removes it, and logs each", async () => {
    const w = await world();
    const sale = await ringDelivery(w);
    const id = String(sale.body.id);

    const before = await asRegister(feeRoute, "GET", { id });
    expect(before.body).toMatchObject({ current: null, quote: { amount: 109, pieces: 2 } });

    const charged = await asRegister(feeRoute, "PUT", { id }, { amount: 109 });
    expect(charged.body.current).toMatchObject({ amount: 109, taxAmount: 6.54 });
    const changed = await asRegister(feeRoute, "PUT", { id }, { amount: 50 });
    expect(changed.body.current).toMatchObject({ amount: 50, taxAmount: 3 });
    expect(await prisma.orderLineItem.count({ where: { salesOrderId: sale.body.id } })).toBe(2);
    expect((await feeLineOf(sale.body.id)).totalTax).toBe(123);

    const removed = await asRegister(feeRoute, "PUT", { id }, { amount: null });
    expect(removed.body.current).toBeNull();
    expect(await feeLineOf(sale.body.id)).toEqual({ line: null, totalTax: 120 });
    expect(await prisma.orderLineItem.count({ where: { salesOrderId: sale.body.id } })).toBe(1);

    const log = await prisma.orderChangeLog.findMany({
      where: { salesOrderId: sale.body.id },
      orderBy: { id: "asc" },
      select: { changeType: true },
    });
    expect(log.map((l) => l.changeType)).toEqual(["LINE_ADDED", "PRICE_CHANGE", "LINE_REMOVED"]);
  });

  it("a handed-over order's fee can't change", async () => {
    const w = await world();
    const sale = await ringDelivery(w, 109);
    await prisma.salesOrder.update({ where: { id: sale.body.id }, data: { status: "FULFILLED" } });
    const res = await asRegister(feeRoute, "PUT", { id: String(sale.body.id) }, { amount: 0 });
    expect(res.statusCode).toBe(409);
    expect(Number((await feeLineOf(sale.body.id)).line?.netPrice)).toBe(109);
  });
});

describe("the fee line is not goods", () => {
  it("generic line edits and returns refuse it", async () => {
    const w = await world();
    const sale = await ringDelivery(w, 109);
    const { line } = await feeLineOf(sale.body.id);
    const ids = { id: String(sale.body.id), lineItemId: String(line?.id) };

    const cancel = await asRegister(lineRoute, "PUT", ids, { action: "cancel", reason: "x" });
    expect(cancel.statusCode).toBe(409);
    const remove = await asRegister(lineRoute, "DELETE", ids);
    expect(remove.statusCode).toBe(409);

    await syncBuiltInRoles({ prisma });
    await prisma.user.create({ data: { id: "boss", email: "boss@example.com" } });
    const admin = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    await prisma.staffMember.create({
      data: { userId: "boss", displayName: "boss", role: "ADMIN", roleId: admin.id },
    });
    sessionMock.mockResolvedValue({ user: { id: "boss", email: "boss@example.com" } });
    const ret = await signedIn(
      returnsRoute,
      "POST",
      {},
      { salesOrderId: sale.body.id, lineItemId: line?.id, reason: "CUSTOMER_CHANGED_MIND" },
    );
    expect(ret.statusCode).toBe(409);
    expect(await prisma.return.count()).toBe(0);

    const kept = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: line!.id } });
    expect(kept.lineItemStatus).toBe("ACTIVE");
  });

  it("sales credit leaves it out and keeps the goods", async () => {
    const w = await world();
    const sale = await ringDelivery(w, 109);
    const credited = await prisma.orderLineItem.findMany({
      where: { salesOrderId: sale.body.id, ...buildLineItemWhere([]) },
      select: { productId: true },
    });
    expect(credited).toEqual([{ productId: w.sofa.id }]);
  });

  it("the day's journal books it to Delivery Fees, with no plug", async () => {
    const w = await world();
    const now = new Date();
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-200",
        status: "FULFILLED",
        orderDate: now,
        customerId: w.customer.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: w.sofa.id,
              productName: "Camelback Sofa",
              orderedQuantity: 1,
              netPrice: 1000,
              vatAmount: 60,
              cost: 400,
            },
            {
              lineNumber: 2,
              productName: "Delivery — Local",
              orderedQuantity: 1,
              netPrice: 94,
              vatAmount: 5.64,
              cost: 0,
            },
          ],
        },
        invoices: { create: [{ invoiceNo: "INV-200", invoiceDate: now, taxAmount: 65.64 }] },
      },
      include: { lineItems: { orderBy: { lineNumber: "asc" } } },
    });
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { deliveryFeeLineItemId: order.lineItems[1].id },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: now,
        paymentType: "Cash",
        method: "CASH",
        paymentAmount: 1159.64,
        status: "COMPLETED",
        customerId: w.customer.id,
      },
    });

    const today = new Date(`${businessDayKey(now, "UTC")}T00:00:00Z`);
    const result = await generateSalesJournal(today, "test");
    const net = new Map<number, number>();
    for (const l of result.journalEntry?.lines ?? []) {
      net.set(
        l.glAccount.id,
        Math.round(((net.get(l.glAccount.id) ?? 0) + l.debit - l.credit) * 100) / 100,
      );
    }
    expect(net.get(w.gl.deliveryIncome.id)).toBe(-94);
    expect(net.get(w.gl.sales.id)).toBe(-1000);
    expect(net.get(w.gl.overShort.id) ?? 0).toBe(0);
  });
});

describe("the delivery tax group setting", () => {
  it("is saved in Settings, and a group that doesn't exist is a 400", async () => {
    const w = await world();
    await signInAdmin();
    const saved = await signedIn(
      settingsRoute,
      "PUT",
      {},
      {
        deliveryFeeTaxGroupId: w.groups.notTaxed.id,
      },
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings.deliveryFeeTaxGroupId).toBe(w.groups.notTaxed.id);

    const missing = await signedIn(settingsRoute, "PUT", {}, { deliveryFeeTaxGroupId: 99999 });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toBe("The delivery fee tax group does not exist.");
  });

  it("keeps its group from being deleted", async () => {
    const w = await world();
    await signInAdmin();
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { deliveryFeeTaxGroupId: w.groups.notTaxed.id },
    });
    const res = await signedIn(taxGroupRoute, "DELETE", { id: String(w.groups.notTaxed.id) });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("delivery fees sell under this group");
    expect(await prisma.taxGroup.count({ where: { id: w.groups.notTaxed.id } })).toBe(1);
  });
});

describe("an order records its store", () => {
  // The register resolved the store to tax the sale and never wrote its id on
  // the order, so everything that taxed the order later -- an added line, a
  // re-rated quote, its delivery fee -- fell back to the deployment default,
  // and charged 0% with none set (this world sets none).
  it("a register order's later line is taxed by its store's district", async () => {
    const w = await world();
    const sale = await asRegister(
      createFromCart,
      "POST",
      {},
      {
        storeLocation: w.store.name,
        items: [{ productId: w.sofa.id, quantity: 1, unitPrice: 1000 }],
      },
    );
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: sale.body.id } });
    expect(order.storeLocationId).toBe(w.store.id);

    const added = await asRegister(
      addLine,
      "POST",
      { id: String(sale.body.id) },
      { productName: "Ottoman", quantity: 1, unitPrice: 200, productId: w.sofa.id },
    );
    expect(added.statusCode).toBe(201);
    expect(added.body.vatAmount).toBe(12);
  });

  it("an exchange order carries its sale's store", async () => {
    const w = await world();
    const sale = await prisma.salesOrder.create({
      data: {
        orderno: "SO-300",
        status: "FULFILLED",
        storeLocation: w.store.name,
        storeLocationId: w.store.id,
        customerId: w.customer.id,
      },
    });
    const ret = await prisma.return.create({
      data: {
        returnNumber: "RET-300",
        reason: "CUSTOMER_CHANGED_MIND",
        salesOrderId: sale.id,
        customerId: w.customer.id,
      },
    });
    await signInAdmin();
    const res = await signedIn(exchangeRoute, "POST", { id: String(ret.id) });
    expect(res.statusCode).toBeLessThan(300);
    const exchange = await prisma.salesOrder.findFirstOrThrow({
      where: { exchangeReturns: { some: { id: ret.id } } },
    });
    expect(exchange.storeLocationId).toBe(w.store.id);
  });
});

describe("the order's totals", () => {
  it("count the fee and leave a cancelled line out (rule 33)", async () => {
    const w = await world();
    const sale = await ringDelivery(w, 109);
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: sale.body.id,
        lineNumber: 9,
        productName: "Cancelled chair",
        orderedQuantity: 1,
        netPrice: 500,
        vatAmount: 30,
        cost: 0,
        lineItemStatus: "CANCELLED",
      },
    });
    const res = await asRegister(orderRoute, "GET", { id: String(sale.body.id) });
    expect(res.statusCode).toBe(200);
    expect(res.body.deliveryFeeLineItemId).toEqual(expect.any(Number));
    expect(res.body.totalTax).toBeCloseTo(126.54, 2);
    expect(res.body.totalAmount).toBeCloseTo(2235.54, 2);
  });
});
