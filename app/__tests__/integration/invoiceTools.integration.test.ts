// /app/__tests__/integration/invoiceTools.integration.test.ts
//
// GAP-07, the invoice tools (owner, 2026-11-03: the store's own flags and
// disclaimers; a copy at today's prices):
//
//   - Line notes: a note on an order line, printed under it and found by the
//     orders search. OrderLineItem had no notes column.
//   - Order flags: the store's own list in Settings; staff put them on orders;
//     the orders list shows and filters by them; one can warn on opening.
//   - Disclaimers: the store's own list; an order is given a COPY of one, so
//     rewording or deleting it changes no order. Printed above the footer.
//   - Pictures on the printed invoice: the line's product's, else its style's.
//   - Duplicating an order: a new quote at today's prices, with no discount.
//
// Found on the way and fixed: the orders list summed cancelled lines into an
// order's total (rule 33) and counted voided payments and refunds as paid.
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
import flagsListRoute from "@/pages/api/order-flags/index";
import { handler as flagRoute } from "@/pages/api/order-flags/[id]";
import disclaimersListRoute from "@/pages/api/order-disclaimers/index";
import { handler as disclaimerRoute } from "@/pages/api/order-disclaimers/[id]";
import { handler as orderFlagsRoute } from "@/pages/api/sales/orders/[id]/flags";
import { handler as orderDisclaimersRoute } from "@/pages/api/sales/orders/[id]/disclaimers";
import { handler as orderDisclaimerRoute } from "@/pages/api/sales/orders/[id]/disclaimers/[disclaimerId]";
import { handler as duplicateRoute } from "@/pages/api/sales/orders/[id]/duplicate";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as orderRoute } from "@/pages/api/sales/orders/[id]";
import ordersListRoute from "@/pages/api/sales/orders/index";
import { handler as printRoute } from "@/pages/api/print/order/[id]";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as pictureRoute } from "@/pages/api/products/[id]/picture";

const sessionMock = getServerSession as jest.Mock;
const owner = { user: { id: "owner", email: "owner@example.com" } } as unknown as Session;

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
    send(payload: unknown) {
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

function req(method: string, query: Record<string, string> = {}, body?: unknown) {
  return { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
}

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => unknown;
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

/** A handler called as the owner, past its gate. */
async function as(handler: Handler, method: string, query = {}, body?: unknown) {
  const res = makeRes();
  await handler(req(method, query, body), res, owner);
  return res;
}

/** A route called through its gate, signed in as the owner (ADMIN). */
async function gated(route: Route, method: string, query = {}, body?: unknown) {
  const res = makeRes();
  await route(req(method, query, body), res);
  return res;
}

/** The register may discount here; who may is discountPolicy.integration.test.ts. */
const CAN_DISCOUNT = { holds: { "sales.discount": true } };

async function ring(body: Record<string, unknown>) {
  const res = makeRes();
  await createFromCart(req("POST", {}, body), res, owner, CAN_DISCOUNT);
  expect([res.statusCode, res.body?.error]).toEqual([201, undefined]);
  return res.body as { id: number; orderno: string };
}

/**
 * A store taxed at 6%, a delivery zone (Local: $79 plus $15 a piece) whose
 * fee books to an income account, a customer in it, and three catalog items: a sofa ($1,000), a chair ($300) and
 * a lamp ($80).
 */
async function world() {
  const deliveryIncome = await prisma.gLAccount.create({
    data: { code: "4-4960", name: "Delivery Fees", accountType: "REVENUE" },
  });
  await prisma.systemGLMapping.create({
    data: { section: "POS_TRANSACTIONS", label: "Delivery Fee", glAccountId: deliveryIncome.id },
  });
  const district = await prisma.taxDistrict.create({
    data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
  });
  const standard = await prisma.taxGroup.create({ data: { name: "Standard" } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: standard.id, taxRate: 0.06, sortOrder: 0 },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE", taxDistrictId: district.id },
  });
  await prisma.deliveryZone.create({
    data: {
      name: "Local",
      baseFee: 79,
      perPieceFee: 15,
      zipCodes: { create: [{ zipCode: "06880" }] },
    },
  });
  const customer = await prisma.customer.create({
    data: {
      firstName: "Ada",
      lastName: "Lane",
      addresses: {
        create: [{ address1: "1 Main St", city: "Westport", state: "CT", zip: "06880" }],
      },
    },
  });
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Living", departmentId: department.id },
  });
  const product = (productNumber: string, name: string, baseRetail: number, extra = {}) =>
    prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseRetail,
        baseCost: baseRetail / 2,
        ...extra,
      },
    });
  return {
    store,
    customer,
    vendor,
    sofa: await product("SOFA-1", "Camelback Sofa", 1000, {
      imageUrl: "/uploads/images/products/sofa.png",
    }),
    chair: await product("CHAIR-1", "Wing Chair", 300),
    lamp: await product("LAMP-1", "Floor Lamp", 80),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** An order of a sofa and a chair, no customer, taken from the store. */
async function simpleOrder(w: World) {
  return ring({
    storeLocation: w.store.name,
    items: [
      { productId: w.sofa.id, quantity: 1, unitPrice: 1000 },
      { productId: w.chair.id, quantity: 1, unitPrice: 300 },
    ],
  });
}

async function linesOf(orderId: number) {
  return prisma.orderLineItem.findMany({
    where: { salesOrderId: orderId },
    orderBy: { id: "asc" },
  });
}

async function changes(orderId: number, changeType: string) {
  return prisma.orderChangeLog.findMany({
    where: { salesOrderId: orderId, changeType },
    orderBy: { id: "asc" },
  });
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
  sessionMock.mockResolvedValue(owner);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Settings › Order flags", () => {
  it("adds, recolours, switches off and deletes the store's own flags", async () => {
    const added = await gated(flagsListRoute, "POST", {}, { name: " Fragile ", color: "amber" });
    expect([added.statusCode, added.body.name, added.body.color]).toEqual([
      201,
      "Fragile",
      "amber",
    ]);
    expect((await gated(flagsListRoute, "POST", {}, { name: "fragile" })).statusCode).toBe(409);
    expect(
      (await gated(flagsListRoute, "POST", {}, { name: "VIP", color: "pink" })).body.error,
    ).toMatch(/colour is one of/);

    const id = String(added.body.id);
    expect((await as(flagRoute, "PUT", { id }, { color: "red", alertOnOpen: true })).body).toEqual(
      expect.objectContaining({ color: "red", alertOnOpen: true }),
    );
    await as(flagRoute, "PUT", { id }, { isActive: false });
    expect((await gated(flagsListRoute, "GET")).body).toEqual([]);
    expect((await gated(flagsListRoute, "GET", { all: "1" })).body).toEqual([
      expect.objectContaining({ name: "Fragile", isActive: false, orderCount: 0 }),
    ]);
    expect((await as(flagRoute, "DELETE", { id })).statusCode).toBe(200);
    expect(await prisma.orderFlag.count()).toBe(0);
  });

  it("a flag orders carry is switched off, not deleted", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const flag = await prisma.orderFlag.create({ data: { name: "VIP" } });
    await as(orderFlagsRoute, "PUT", { id: String(order.id) }, { flagIds: [flag.id] });
    const res = await as(flagRoute, "DELETE", { id: String(flag.id) });
    expect([res.statusCode, res.body.error]).toEqual([409, expect.stringMatching(/Switch it off/)]);
  });
});

describe("flags on an order", () => {
  it("sets the order's flags, in the store's order, and logs each one added or taken off", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const id = String(order.id);
    const vip = await prisma.orderFlag.create({ data: { name: "VIP", sortOrder: 2 } });
    const call = await prisma.orderFlag.create({
      data: { name: "Call before delivery", color: "blue", alertOnOpen: true, sortOrder: 1 },
    });

    const set = await as(orderFlagsRoute, "PUT", { id }, { flagIds: [vip.id, call.id, vip.id] });
    expect(set.body.flags.map((f: { name: string }) => f.name)).toEqual([
      "Call before delivery",
      "VIP",
    ]);
    expect((await changes(order.id, "FLAG_ADDED")).map((c) => c.newValue).sort()).toEqual([
      "Call before delivery",
      "VIP",
    ]);

    // The order screen reads them, with which one warns on opening.
    const got = await as(orderRoute, "GET", { id });
    expect(got.body.flags).toEqual([
      { id: call.id, name: "Call before delivery", color: "blue", alertOnOpen: true },
      { id: vip.id, name: "VIP", color: "gray", alertOnOpen: false },
    ]);

    await as(orderFlagsRoute, "PUT", { id }, { flagIds: [call.id] });
    expect((await changes(order.id, "FLAG_REMOVED")).map((c) => c.previousValue)).toEqual(["VIP"]);
    expect(await prisma.salesOrderFlag.count()).toBe(1);
  });

  it("a switched-off flag goes on no new order, and stays on one that has it", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const other = await simpleOrder(w);
    const flag = await prisma.orderFlag.create({ data: { name: "Spring sale" } });
    await as(orderFlagsRoute, "PUT", { id: String(order.id) }, { flagIds: [flag.id] });
    await prisma.orderFlag.update({ where: { id: flag.id }, data: { isActive: false } });

    const refused = await as(
      orderFlagsRoute,
      "PUT",
      { id: String(other.id) },
      { flagIds: [flag.id] },
    );
    expect([refused.statusCode, refused.body.error]).toEqual([
      400,
      expect.stringMatching(/switched off/),
    ]);
    const kept = await as(orderFlagsRoute, "PUT", { id: String(order.id) }, { flagIds: [flag.id] });
    expect([kept.statusCode, kept.body.flags.length]).toEqual([200, 1]);
  });

  it("refuses what isn't a list of flags, a flag that doesn't exist, and an order that doesn't", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const id = String(order.id);
    expect((await as(orderFlagsRoute, "PUT", { id }, { flagIds: "1" })).statusCode).toBe(400);
    expect((await as(orderFlagsRoute, "PUT", { id }, { flagIds: [999] })).body.error).toMatch(
      /doesn't exist/,
    );
    expect((await as(orderFlagsRoute, "PUT", { id: "99999" }, { flagIds: [] })).statusCode).toBe(
      404,
    );
  });
});

describe("Settings › Disclaimers, and disclaimers on an order", () => {
  it("copies the text onto the order, which rewording or deleting the store's changes nothing on", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const id = String(order.id);
    const made = await gated(
      disclaimersListRoute,
      "POST",
      {},
      { name: "Sold as-is", text: "Sold as-is. No returns." },
    );
    expect(made.statusCode).toBe(201);
    const disclaimerId = made.body.id as number;

    const added = await as(
      orderDisclaimersRoute,
      "POST",
      { id },
      { orderDisclaimerId: disclaimerId },
    );
    expect([added.statusCode, added.body.disclaimers]).toEqual([
      201,
      [
        expect.objectContaining({
          orderDisclaimerId: disclaimerId,
          text: "Sold as-is. No returns.",
        }),
      ],
    ]);
    expect((await changes(order.id, "DISCLAIMER_ADDED")).map((c) => c.newValue)).toEqual([
      "Sold as-is",
    ]);
    const twice = await as(
      orderDisclaimersRoute,
      "POST",
      { id },
      { orderDisclaimerId: disclaimerId },
    );
    expect([twice.statusCode, twice.body.error]).toEqual([409, expect.stringMatching(/already/)]);

    await as(disclaimerRoute, "PUT", { id: String(disclaimerId) }, { text: "All sales final." });
    expect((await as(orderRoute, "GET", { id })).body.disclaimers[0].text).toBe(
      "Sold as-is. No returns.",
    );

    await as(disclaimerRoute, "DELETE", { id: String(disclaimerId) });
    const after = await prisma.salesOrderDisclaimer.findMany({ where: { salesOrderId: order.id } });
    expect(after).toEqual([
      expect.objectContaining({ orderDisclaimerId: null, text: "Sold as-is. No returns." }),
    ]);

    const removed = await as(orderDisclaimerRoute, "DELETE", {
      id,
      disclaimerId: String(after[0].id),
    });
    expect([removed.statusCode, removed.body.disclaimers]).toEqual([200, []]);
    expect((await changes(order.id, "DISCLAIMER_REMOVED")).map((c) => c.previousValue)).toEqual([
      "Sold as-is. No returns.",
    ]);
  });

  it("changes only on a quote or an order, and gives no order a switched-off disclaimer", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const id = String(order.id);
    const off = await prisma.orderDisclaimer.create({
      data: { name: "Old", text: "Old text", isActive: false },
    });
    const on = await prisma.orderDisclaimer.create({ data: { name: "Special order", text: "SO" } });
    expect(
      (await as(orderDisclaimersRoute, "POST", { id }, { orderDisclaimerId: off.id })).body.error,
    ).toMatch(/switched off/);

    const given = await as(orderDisclaimersRoute, "POST", { id }, { orderDisclaimerId: on.id });
    const copyId = String(given.body.disclaimers[0].id);

    for (const status of ["FULFILLED", "CANCELLED"] as const) {
      await prisma.salesOrder.update({ where: { id: order.id }, data: { status } });
      const added = await as(orderDisclaimersRoute, "POST", { id }, { orderDisclaimerId: off.id });
      const removed = await as(orderDisclaimerRoute, "DELETE", { id, disclaimerId: copyId });
      expect([added.statusCode, removed.statusCode]).toEqual([409, 409]);
    }
    expect(await prisma.salesOrderDisclaimer.count()).toBe(1);
  });

  it("refuses to change a return's own order", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const returnOrder = await simpleOrder(w);
    await prisma.return.create({
      data: {
        returnNumber: "RET-1",
        reason: "DEFECTIVE",
        salesOrderId: order.id,
        returnOrderId: returnOrder.id,
      },
    });
    const d = await prisma.orderDisclaimer.create({ data: { name: "X", text: "X" } });
    const res = await as(
      orderDisclaimersRoute,
      "POST",
      { id: String(returnOrder.id) },
      { orderDisclaimerId: d.id },
    );
    expect([res.statusCode, res.body.error]).toEqual([409, expect.stringMatching(/RET-1/)]);
  });
});

describe("a note on a line", () => {
  it("saves, clears and logs a line's note; the orders search finds the order by it", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const other = await simpleOrder(w);
    const [sofa] = await linesOf(order.id);
    const q = { id: String(order.id), lineItemId: String(sofa.id) };

    const saved = await as(lineRoute, "PUT", q, { action: "note", notes: "  Legs in walnut " });
    expect([saved.statusCode, saved.body.notes]).toEqual([200, "Legs in walnut"]);
    // Saving the same note again writes no second history row.
    await as(lineRoute, "PUT", q, { action: "note", notes: "Legs in walnut" });
    expect((await changes(order.id, "LINE_NOTE")).map((c) => c.newValue)).toEqual([
      "Legs in walnut",
    ]);

    const found = await gated(ordersListRoute, "GET", { search: "walnut" });
    expect(found.body.orders.map((o: { id: number }) => o.id)).toEqual([order.id]);
    expect(other.id).not.toBe(order.id);

    const printed = await as(printRoute, "GET", { id: String(order.id) });
    expect(printed.body.lineItems.find((l: { id: number }) => l.id === sofa.id).notes).toBe(
      "Legs in walnut",
    );

    await as(lineRoute, "PUT", q, { action: "note", notes: "  " });
    expect((await prisma.orderLineItem.findUniqueOrThrow({ where: { id: sofa.id } })).notes).toBe(
      null,
    );
    expect((await gated(ordersListRoute, "GET", { search: "walnut" })).body.orders).toEqual([]);
  });

  it("refuses a note that is too long or isn't text, and one on a cancelled line", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const [sofa, chair] = await linesOf(order.id);
    const q = (line: { id: number }) => ({ id: String(order.id), lineItemId: String(line.id) });
    expect(
      (await as(lineRoute, "PUT", q(sofa), { action: "note", notes: "x".repeat(501) })).body.error,
    ).toMatch(/under 500/);
    expect((await as(lineRoute, "PUT", q(sofa), { action: "note", notes: 7 })).statusCode).toBe(
      400,
    );
    await prisma.orderLineItem.update({
      where: { id: chair.id },
      data: { lineItemStatus: "CANCELLED" },
    });
    expect((await as(lineRoute, "PUT", q(chair), { action: "note", notes: "x" })).statusCode).toBe(
      400,
    );
  });
});

describe("the orders list", () => {
  it("shows each order's flags and shows only the orders carrying the one chosen", async () => {
    const w = await world();
    const flagged = await simpleOrder(w);
    await simpleOrder(w);
    const flag = await prisma.orderFlag.create({ data: { name: "Fragile", color: "amber" } });
    await as(orderFlagsRoute, "PUT", { id: String(flagged.id) }, { flagIds: [flag.id] });

    const all = await gated(ordersListRoute, "GET");
    expect(all.body.orders).toHaveLength(2);
    const only = await gated(ordersListRoute, "GET", { flag: String(flag.id) });
    expect(only.body.orders.map((o: { id: number; flags: unknown }) => [o.id, o.flags])).toEqual([
      [flagged.id, [{ id: flag.id, name: "Fragile", color: "amber", alertOnOpen: false }]],
    ]);
  });

  it("totals what was sold and what was paid, not cancelled lines, voided payments or refunds", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const [, chair] = await linesOf(order.id);
    await prisma.orderLineItem.update({
      where: { id: chair.id },
      data: { lineItemStatus: "CANCELLED" },
    });
    const pay = (paymentAmount: number, status: "COMPLETED" | "VOIDED", isRefund = false) =>
      prisma.payment.create({
        data: {
          salesOrderId: order.id,
          paymentDate: new Date(),
          paymentType: "Cash",
          paymentAmount,
          status,
          isRefund,
        },
      });
    await pay(500, "COMPLETED");
    await pay(400, "VOIDED");
    await pay(100, "COMPLETED", true);

    const row = (await gated(ordersListRoute, "GET")).body.orders[0];
    // The sofa alone: $1,000 and its 6% tax; the chair was cancelled.
    expect([row.totalAmount, row.totalPaid]).toEqual([1060, 400]);
  });
});

describe("the printed invoice", () => {
  it("prints each line's picture -- its product's, else its style's -- and the order's disclaimers", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const [sofa, chair] = await linesOf(order.id);
    const style = await prisma.vendorStyle.create({
      data: {
        styleNumber: "WING",
        name: "Wing Chair",
        vendorId: w.vendor.id,
        imageUrl: "/uploads/line-drawings/v/WING.png",
      },
    });
    await prisma.orderLineItem.update({
      where: { id: chair.id },
      data: { vendorStyleId: style.id },
    });
    const lamp = await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        productId: w.lamp.id,
        productName: "Floor Lamp",
        orderedQuantity: 1,
        netPrice: 80,
        cost: 40,
      },
    });
    const lampStyle = await prisma.vendorStyle.create({
      data: {
        styleNumber: "LAMP",
        name: "Floor Lamp",
        vendorId: w.vendor.id,
        imageUrl: "/uploads/line-drawings/v/LAMP.png",
      },
    });
    await prisma.product.update({
      where: { id: w.lamp.id },
      data: { vendorStyleId: lampStyle.id },
    });
    const d = await prisma.orderDisclaimer.create({ data: { name: "SO", text: "Special order." } });
    await as(orderDisclaimersRoute, "POST", { id: String(order.id) }, { orderDisclaimerId: d.id });

    const printed = await as(printRoute, "GET", { id: String(order.id) });
    const picture = (id: number) =>
      printed.body.lineItems.find((l: { id: number }) => l.id === id).imageUrl;
    expect([picture(sofa.id), picture(chair.id), picture(lamp.id)]).toEqual([
      "/uploads/images/products/sofa.png",
      "/uploads/line-drawings/v/WING.png",
      "/uploads/line-drawings/v/LAMP.png",
    ]);
    expect(printed.body.disclaimers).toEqual(["Special order."]);
  });

  it("a configured line's product carries the picture of what it was configured from", async () => {
    const w = await world();
    const order = await ring({
      storeLocation: w.store.name,
      items: [
        {
          type: "CONFIGURED",
          productId: w.sofa.id,
          quantity: 1,
          unitPrice: 2400,
          cost: 1200,
          name: "Custom Sofa",
          vendor: "V",
        },
      ],
    });
    const [line] = await linesOf(order.id);
    const minted = await prisma.product.findUniqueOrThrow({ where: { id: line.productId! } });
    // The picture only: a style link would let editing the style reprice it.
    expect([minted.id === w.sofa.id, minted.imageUrl, minted.vendorStyleId]).toEqual([
      false,
      "/uploads/images/products/sofa.png",
      null,
    ]);
  });

  it("clears a product's picture, and answers 404 for a product that doesn't exist", async () => {
    const w = await world();
    const res = makeRes();
    await pictureRoute(req("DELETE", { id: String(w.sofa.id) }), res);
    expect([res.statusCode, res.body]).toEqual([200, { imageUrl: null }]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: w.sofa.id } })).imageUrl).toBe(
      null,
    );
    const missing = makeRes();
    await pictureRoute(req("DELETE", { id: "99999" }), missing);
    expect(missing.statusCode).toBe(404);
  });
});

describe("duplicating an order", () => {
  /**
   * An order sold to the customer for delivery: two sofas at 10% off, a chair
   * (cancelled later), a custom sectional at $2,400, a delivery fee cut to $50,
   * a note on the sofa line, a flag, a disclaimer, an order note, a payment,
   * and a hold on the sofa line.
   */
  async function soldOrder(w: World) {
    const order = await ring({
      storeLocation: w.store.name,
      customerId: w.customer.id,
      deliveryMethod: "DELIVERY",
      deliveryFee: 50,
      orderNotes: "Call her husband, not her",
      items: [
        {
          productId: w.sofa.id,
          quantity: 2,
          unitPrice: 1000,
          discounts: [{ type: "PERCENT", value: 10 }],
        },
        { productId: w.chair.id, quantity: 1, unitPrice: 300 },
        {
          type: "CONFIGURED",
          productId: w.sofa.id,
          quantity: 1,
          unitPrice: 2400,
          cost: 1200,
          name: "Custom Sectional",
          vendor: "V",
          description: "Grade C, navy",
        },
      ],
    });
    const lines = await linesOf(order.id);
    const [sofa, chair] = lines;
    await as(
      lineRoute,
      "PUT",
      { id: String(order.id), lineItemId: String(chair.id) },
      { action: "cancel", reason: "Changed her mind" },
    );
    await prisma.orderLineItem.update({
      where: { id: sofa.id },
      data: { notes: "Legs in walnut", holdUntil: new Date("2099-01-01") },
    });
    const flag = await prisma.orderFlag.create({ data: { name: "VIP" } });
    await as(orderFlagsRoute, "PUT", { id: String(order.id) }, { flagIds: [flag.id] });
    const d = await prisma.orderDisclaimer.create({ data: { name: "SO", text: "Special order." } });
    await as(orderDisclaimersRoute, "POST", { id: String(order.id) }, { orderDisclaimerId: d.id });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date(),
        paymentType: "Cash",
        paymentAmount: 1000,
        status: "COMPLETED",
      },
    });
    return order;
  }

  it("makes a new quote of the goods at today's prices, with no discount and the zone's fee", async () => {
    const w = await world();
    const original = await soldOrder(w);
    // The sofa's retail went up since.
    await prisma.product.update({ where: { id: w.sofa.id }, data: { baseRetail: 1100 } });

    const res = await as(duplicateRoute, "POST", { id: String(original.id) });
    expect(res.statusCode).toBe(201);
    const copy = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: res.body.id },
      include: {
        lineItems: { orderBy: { lineNumber: "asc" } },
        payments: true,
        flags: true,
        disclaimers: true,
        inventoryPositions: true,
      },
    });
    expect(copy.orderno).not.toBe(original.orderno);
    expect(copy).toEqual(
      expect.objectContaining({
        status: "QUOTE",
        customerId: w.customer.id,
        storeLocationId: w.store.id,
        deliveryMethod: "DELIVERY",
        salesperson: "Owner",
        orderNotes: null,
        payments: [],
        flags: [],
        disclaimers: [],
        inventoryPositions: [],
      }),
    );

    const fee = copy.lineItems.find((l) => l.id === copy.deliveryFeeLineItemId)!;
    const goods = copy.lineItems.filter((l) => l.id !== copy.deliveryFeeLineItemId);
    // Two sofas at $1,100 with no discount, and the sectional at what it was
    // sold for: its own product's retail. The cancelled chair isn't copied.
    expect(
      goods.map((l) => [
        l.productName,
        Number(l.orderedQuantity),
        Number(l.netPrice),
        Number(l.listPrice),
      ]),
    ).toEqual([
      ["Camelback Sofa", 2, 2200, 1100],
      ["Custom Sectional", 1, 2400, 2400],
    ]);
    expect(goods.map((l) => [l.notes, l.holdUntil, l.selectedGrade])).toEqual([
      ["Legs in walnut", null, null],
      [null, null, "Grade C, navy"],
    ]);
    // The zone's fee for three pieces: $79 + 3 x $15, not the $50 it was cut to.
    expect(Number(fee.netPrice)).toBe(124);
    expect((await changes(copy.id, "COPIED_FROM")).map((c) => c.newValue)).toEqual([
      original.orderno,
    ]);
  });

  it("is priced exactly as the same cart rung up at the register today", async () => {
    const w = await world();
    const original = await soldOrder(w);
    // What the sofa costs the store went up since: the copy costs what a sale today does.
    await prisma.product.update({ where: { id: w.sofa.id }, data: { baseCost: 550 } });
    const copyId = (await as(duplicateRoute, "POST", { id: String(original.id) })).body.id;
    const sectional = (await linesOf(original.id))[2];

    const rung = await ring({
      storeLocation: w.store.name,
      customerId: w.customer.id,
      deliveryMethod: "DELIVERY",
      deliveryFee: 124,
      items: [
        { productId: w.sofa.id, quantity: 2, unitPrice: 1000 },
        { productId: sectional.productId, quantity: 1, unitPrice: 2400 },
      ],
    });
    const money = async (id: number) => {
      const order = await prisma.salesOrder.findUniqueOrThrow({
        where: { id },
        include: { lineItems: { orderBy: { id: "asc" } } },
      });
      return {
        totalTax: Number(order.totalTax),
        lines: order.lineItems.map((l) => [
          Number(l.netPrice),
          Number(l.vatRate),
          Number(l.vatAmount),
          Number(l.cost),
        ]),
      };
    };
    expect(await money(copyId)).toEqual(await money(rung.id));
  });

  it("a copy made by mistake can be deleted, with its history, flags and disclaimers", async () => {
    const w = await world();
    const original = await soldOrder(w);
    const copyId = (await as(duplicateRoute, "POST", { id: String(original.id) })).body.id;
    const id = String(copyId);
    const flag = await prisma.orderFlag.create({ data: { name: "Check with manager" } });
    await as(orderFlagsRoute, "PUT", { id }, { flagIds: [flag.id] });
    const d = await prisma.orderDisclaimer.create({ data: { name: "AS-IS", text: "As is." } });
    await as(orderDisclaimersRoute, "POST", { id }, { orderDisclaimerId: d.id });

    // Its change log ("copied from", the flag, the disclaimer) used to block the delete.
    const res = await as(orderRoute, "DELETE", { id });
    expect(res.statusCode).toBe(204);
    expect(await prisma.salesOrder.findUnique({ where: { id: copyId } })).toBeNull();
    expect(await prisma.orderChangeLog.count({ where: { salesOrderId: copyId } })).toBe(0);
    // The original keeps its own.
    expect([
      await prisma.salesOrderFlag.count(),
      await prisma.salesOrderDisclaimer.count(),
    ]).toEqual([1, 1]);
  });

  it("copies nothing from a return's own order, or from an order with nothing left on it", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const returnOrder = await simpleOrder(w);
    await prisma.return.create({
      data: {
        returnNumber: "RET-9",
        reason: "DEFECTIVE",
        salesOrderId: order.id,
        returnOrderId: returnOrder.id,
      },
    });
    const ofReturn = await as(duplicateRoute, "POST", { id: String(returnOrder.id) });
    expect([ofReturn.statusCode, ofReturn.body.error]).toEqual([
      409,
      expect.stringMatching(/RET-9/),
    ]);

    await prisma.orderLineItem.updateMany({
      where: { salesOrderId: order.id },
      data: { lineItemStatus: "CANCELLED" },
    });
    const empty = await as(duplicateRoute, "POST", { id: String(order.id) });
    expect([empty.statusCode, empty.body.error]).toEqual([
      400,
      expect.stringMatching(/nothing to copy/),
    ]);
    expect((await as(duplicateRoute, "POST", { id: "99999" })).statusCode).toBe(404);
    expect(await prisma.salesOrder.count()).toBe(2);
  });

  it("leaves out a zero-quantity line and one given back on an exchange", async () => {
    const w = await world();
    const order = await simpleOrder(w);
    const [, chair] = await linesOf(order.id);
    await prisma.orderLineItem.update({ where: { id: chair.id }, data: { orderedQuantity: 0 } });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        productId: w.lamp.id,
        productName: "Floor Lamp",
        orderedQuantity: -1,
        netPrice: -80,
        cost: -40,
      },
    });
    const copyId = (await as(duplicateRoute, "POST", { id: String(order.id) })).body.id;
    expect((await linesOf(copyId)).map((l) => l.productName)).toEqual(["Camelback Sofa"]);
  });
});
