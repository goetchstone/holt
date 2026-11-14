// /app/__tests__/integration/tradeTierSales.integration.test.ts
//
// GAP-06 parts B and C together: a trade customer buying an item on a
// scheduled sale (DECISIONS 60 and 61).
//
// Part B made a product's sale price its list price on the store's day
// (lib/pricing/salePrice.ts); part C gave a trade customer's eligible lines a
// baseline of retail less their tier, with a store setting,
// AppSettings.pricing.tradeDiscountOnSaleItems (off by default), deciding
// whether a tier also comes off a sale price. They meet in one function,
// catalogLinePolicies (lib/sales/discountApproval.ts), which every writer runs
// (rule 42): the register, duplicate and a house call's service line. The
// product lookups hand the screens the same three facts (lib/pricing/screenPricing.ts),
// so the price a screen sends is the one the server accepts without a PIN.
//
// Real routes, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, getAppSettings, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { saleToday } from "@/lib/pricing/salePrice";
import { priceLineForTier, tierFieldsFromLookup } from "@/lib/pricing/tradeTier";
import { catalogRetailPrice } from "@/lib/pos/cartPricing";
import { duplicateOrder } from "@/lib/sales/duplicateOrder";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as addLine } from "@/pages/api/sales/orders/[id]/line-items";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as orderRoute } from "@/pages/api/sales/orders/[id]";
import customersRoute from "@/pages/api/customers/index";
import productsRoute from "@/pages/api/products/index";
import findRoute from "@/pages/api/products/find-by-identifier";
import houseCallsRoute from "@/pages/api/service/house-calls/index";

const cashier = { user: { email: "cashier@example.com" } } as unknown as Session;
const NO_DISCOUNT = { holds: {} };

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: { holds: Record<string, boolean> },
) => unknown;
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as Body | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Body) {
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
}

/** A route's handler as a cashier who may discount nothing on their own. */
async function call(
  handler: Handler,
  query: Record<string, string>,
  body: unknown,
  method = "POST",
) {
  const res = makeRes();
  const req = {
    method,
    query,
    body,
    cookies: {},
    headers: {},
  } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse, cashier, NO_DISCOUNT);
  return { status: res.statusCode, body: res.body as Body };
}

/** A gated route's default export, signed in as `who`. */
async function asStaff(
  route: Route,
  who: string,
  method: string,
  query: Record<string, string>,
  body: unknown = {},
) {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  const res = makeRes();
  await route(
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status: res.statusCode, body: res.body as Body };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

/** The store's say on a tier and a sale price (Settings › Pricing). */
async function tierOnSaleItems(on: boolean) {
  await prisma.appSettings.update({
    where: { organizationId: DEFAULT_ORG_ID },
    data: { pricing: { tradeDiscountOnSaleItems: on } },
  });
  invalidateAppSettingsCache();
}

/**
 * A $1,000 sofa on today's sale at $600, a $250 house-call visit, a 20% tier,
 * a trade customer on it and a walk-in.
 */
async function world() {
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Harbor Works" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Seating", departmentId: department.id },
  });
  const product = (productNumber: string, baseRetail: number, extra: object = {}) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseRetail,
        ...extra,
      },
    });
  const sofa = await product("SOFA-1", 1000);
  const visit = await product("HC-VISIT", 250, { serviceType: "HOUSE_CALL" });
  const designer = await prisma.tradeTier.create({
    data: { name: "Designer", discountPercent: 20 },
  });
  const trade = await prisma.customer.create({
    data: { firstName: "Tess", lastName: "Trade", isTradeAccount: true, tradeTierId: designer.id },
  });
  const walkIn = await prisma.customer.create({ data: { firstName: "Walt", lastName: "In" } });
  return { store, vendor, sofa, visit, designer, trade, walkIn };
}

type World = Awaited<ReturnType<typeof world>>;

/** A sale on the store's day today, written straight to the table. */
async function onSaleToday(items: { productId: number; salePrice: number }[]) {
  const today = await saleToday();
  return prisma.sale.create({
    data: {
      name: "Spring sale",
      startsOn: new Date(`${today}T00:00:00.000Z`),
      endsOn: new Date(`${today}T00:00:00.000Z`),
      createdBy: "test",
      items: { create: items },
    },
  });
}

/** The sale ends: a manager ends it early (lib/pricing/salePrice.ts). */
async function endSale(saleId: number) {
  await prisma.sale.update({
    where: { id: saleId },
    data: { endedEarlyAt: new Date(), endedEarlyBy: "manager" },
  });
}

/** A sale at the register for `customerId`, as the cashier. */
function ring(w: World, customerId: number, productId: number, unitPrice: number) {
  return call(
    createFromCart,
    {},
    {
      storeLocation: w.store.name,
      customerId,
      items: [{ productId, quantity: 1, unitPrice, discounts: [] }],
    },
  );
}

async function lineOf(orderId: number) {
  const line = await prisma.orderLineItem.findFirstOrThrow({
    where: { salesOrderId: orderId },
    orderBy: { lineNumber: "asc" },
  });
  return money(line);
}

/** The cashier re-enters the price of an order's first line. */
async function editPrice(orderId: number, unitPrice: number) {
  const line = await prisma.orderLineItem.findFirstOrThrow({
    where: { salesOrderId: orderId },
    orderBy: { lineNumber: "asc" },
  });
  return call(
    lineRoute,
    { id: String(orderId), lineItemId: String(line.id) },
    { action: "update", unitPrice },
    "PUT",
  );
}

/** The cashier hands a quote to another customer. */
function relink(orderId: number, customerId: number) {
  return call(orderRoute, { id: String(orderId) }, { customerId }, "PUT");
}

const money = (line: {
  listPrice: unknown;
  netPrice: unknown;
  tradeDiscountPercent: unknown;
  tradeTierId: number | null;
}) => ({
  list: line.listPrice == null ? null : Number(line.listPrice),
  net: Number(line.netPrice),
  tradePercent: line.tradeDiscountPercent == null ? null : Number(line.tradeDiscountPercent),
  tierId: line.tradeTierId,
});

const approvals = () => prisma.orderChangeLog.count({ where: { changeType: "DISCOUNT_APPROVED" } });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a trade customer buys an item on sale at the register", () => {
  it("with the setting off: the sale price, no tier, no PIN; the tier off the sale price is a discount", async () => {
    const w = await world();
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);

    const atSale = await ring(w, w.trade.id, w.sofa.id, 600);
    expect(atSale.status).toBe(201);
    expect(await lineOf(atSale.body.id)).toEqual({
      list: 600,
      net: 600,
      tradePercent: null,
      tierId: null,
    });
    expect(await approvals()).toBe(0);

    // The tier on top of the sale price is a cashier's 20% off the sale price.
    const tierOnSale = await ring(w, w.trade.id, w.sofa.id, 480);
    expect(tierOnSale.status).toBe(403);
    expect(tierOnSale.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 20 });
  });

  it("with the setting on: the tier comes off the sale price, needs no PIN, and is recorded", async () => {
    const w = await world();
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);
    await tierOnSaleItems(true);

    const res = await ring(w, w.trade.id, w.sofa.id, 480);
    expect(res.status).toBe(201);
    expect(await lineOf(res.body.id)).toEqual({
      list: 600,
      net: 480,
      tradePercent: 20,
      tierId: w.designer.id,
    });
    expect(await approvals()).toBe(0);
  });

  it("adding a line to a trade customer's quote during the sale follows the same rule", async () => {
    const w = await world();
    const quote = await ring(w, w.trade.id, w.visit.id, 200);
    expect(quote.status).toBe(201);
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);

    const refused = await call(
      addLine,
      { id: String(quote.body.id) },
      { productName: "Sofa", productId: w.sofa.id, quantity: 1, unitPrice: 480 },
    );
    expect(refused.status).toBe(403);

    await tierOnSaleItems(true);
    const added = await call(
      addLine,
      { id: String(quote.body.id) },
      { productName: "Sofa", productId: w.sofa.id, quantity: 1, unitPrice: 480 },
    );
    expect(added.status).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: quote.body.id, productId: w.sofa.id },
    });
    expect(money(line)).toEqual({ list: 600, net: 480, tradePercent: 20, tierId: w.designer.id });
  });
});

describe("duplicating a trade customer's order during a sale", () => {
  async function soldBeforeTheSale(w: World) {
    const sold = await ring(w, w.trade.id, w.sofa.id, 800);
    expect(sold.status).toBe(201);
    expect(await lineOf(sold.body.id)).toMatchObject({ list: 1000, net: 800, tradePercent: 20 });
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);
    const settings = await getAppSettings();
    return prisma.$transaction((tx) =>
      duplicateOrder(tx, {
        orderId: sold.body.id,
        actor: { email: "manager@example.com", displayName: "manager" },
        settings,
      }),
    );
  }

  it("with the setting off, the copy is at today's sale price with no tier", async () => {
    const w = await world();
    const copy = await soldBeforeTheSale(w);
    expect(await lineOf(copy.id)).toEqual({
      list: 600,
      net: 600,
      tradePercent: null,
      tierId: null,
    });
  });

  it("with the setting on, the copy is at the tier off today's sale price", async () => {
    const w = await world();
    await tierOnSaleItems(true);
    const copy = await soldBeforeTheSale(w);
    expect(await lineOf(copy.id)).toEqual({
      list: 600,
      net: 480,
      tradePercent: 20,
      tierId: w.designer.id,
    });
  });
});

describe("a house call for a trade customer", () => {
  async function book(customerId: number) {
    const res = await asStaff(
      houseCallsRoute,
      "mia",
      "POST",
      {},
      { customerId: String(customerId) },
    );
    expect(res.status).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { productName: "HC-VISIT" },
      orderBy: { id: "desc" },
    });
    return money(line);
  }

  it("books the visit at the customer's tier, like any catalog product, and at retail for a walk-in", async () => {
    const w = await world();
    await makeStaff("mia", "MANAGER");
    expect(await book(w.trade.id)).toEqual({
      list: 250,
      net: 200,
      tradePercent: 20,
      tierId: w.designer.id,
    });
    expect(await book(w.walkIn.id)).toEqual({
      list: 250,
      net: 250,
      tradePercent: null,
      tierId: null,
    });
  });

  it("on sale, the visit takes the tier only when the store says a tier applies to sale prices", async () => {
    const w = await world();
    await makeStaff("mia", "MANAGER");
    await onSaleToday([{ productId: w.visit.id, salePrice: 150 }]);
    expect(await book(w.trade.id)).toEqual({
      list: 150,
      net: 150,
      tradePercent: null,
      tierId: null,
    });
    await tierOnSaleItems(true);
    expect(await book(w.trade.id)).toEqual({
      list: 150,
      net: 120,
      tradePercent: 20,
      tierId: w.designer.id,
    });
  });
});

describe("the screen and the server agree on a sale item", () => {
  /**
   * What the register does: look the product up, build the line from the
   * lookup (tierFieldsFromLookup), price it for the customer's tier from the
   * customer search (priceLineForTier), and send that price.
   */
  async function screenPrice(w: World, lookup: "search" | "scan") {
    const customers = await asStaff(customersRoute, "boss", "GET", { search: "Tess" });
    const tier = customers.body.data.find((c: Body) => c.id === w.trade.id).tradeTier;
    const product =
      lookup === "search"
        ? (await asStaff(productsRoute, "boss", "GET", { search: "SOFA" })).body.products.find(
            (p: Body) => p.id === w.sofa.id,
          )
        : (await asStaff(findRoute, "boss", "GET", { identifier: "SOFA-1" })).body;
    const retail = catalogRetailPrice(product)!;
    return { product, line: priceLineForTier(tierFieldsFromLookup(product, retail), tier) };
  }

  it("the lookups carry the sale flag and the store's setting, and the price they make needs no PIN", async () => {
    const w = await world();
    await makeStaff("boss", "ADMIN");
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);

    for (const lookup of ["search", "scan"] as const) {
      const off = await screenPrice(w, lookup);
      expect(off.product).toMatchObject({
        baseRetail: 600,
        regularRetail: 1000,
        onSale: true,
        tradeEligible: true,
        tradeDiscountOnSaleItems: false,
      });
      expect(off.line).toMatchObject({ price: 600, tradePercent: null });
    }
    const sentOff = await ring(w, w.trade.id, w.sofa.id, (await screenPrice(w, "scan")).line.price);
    expect(sentOff.status).toBe(201);

    await tierOnSaleItems(true);
    for (const lookup of ["search", "scan"] as const) {
      const on = await screenPrice(w, lookup);
      expect(on.product.tradeDiscountOnSaleItems).toBe(true);
      expect(on.line).toMatchObject({ price: 480, tradePercent: 20 });
    }
    const sentOn = await ring(
      w,
      w.trade.id,
      w.sofa.id,
      (await screenPrice(w, "search")).line.price,
    );
    expect(sentOn.status).toBe(201);
    expect(await lineOf(sentOn.body.id)).toMatchObject({ net: 480, tradePercent: 20 });
    expect(await approvals()).toBe(0);
  });
});

// The two writers that judge a line already written -- a price edit
// (currentLinePolicies) and a quote changing hands (planQuoteTrade) -- read the
// list the line recorded with the sale flag recorded beside it
// (OrderLineItem.listOnSale), never with whether the product is on sale today.
// Paired with today's flag, a sale-price list read after the sale ended would
// take the tier off the sale price with no PIN; a regular-price list read
// while a sale is on would lose the tier the customer is entitled to.

describe("re-entering the price of a line sold at a sale price", () => {
  it("during the sale: the tier off the sale price needs a PIN with the setting off, and none with it on", async () => {
    const w = await world();
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);
    const sold = await ring(w, w.trade.id, w.sofa.id, 600);
    expect(sold.status).toBe(201);

    const off = await editPrice(sold.body.id, 480);
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 20 });

    await tierOnSaleItems(true);
    const on = await editPrice(sold.body.id, 480);
    expect(on.status).toBe(200);
    expect(await lineOf(sold.body.id)).toEqual({
      list: 600,
      net: 480,
      tradePercent: 20,
      tierId: w.designer.id,
    });
    expect(await approvals()).toBe(0);
  });

  it("after the sale ends, with the setting off: the tier off the recorded sale price still needs a PIN", async () => {
    const w = await world();
    const sale = await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);
    const sold = await ring(w, w.trade.id, w.sofa.id, 600);
    expect(sold.status).toBe(201);
    await endSale(sale.id);

    const edit = await editPrice(sold.body.id, 480);
    expect(edit.status).toBe(403);
    expect(edit.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 20 });
    expect(await lineOf(sold.body.id)).toEqual({
      list: 600,
      net: 600,
      tradePercent: null,
      tierId: null,
    });
  });
});

describe("a quote changing hands across a sale", () => {
  it("a walk-in's quote written at the sale price, handed to a trade customer during the sale and after it: no tier with the setting off", async () => {
    const w = await world();
    const sale = await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);
    const quote = await ring(w, w.walkIn.id, w.sofa.id, 600);
    expect(quote.status).toBe(201);

    const during = await relink(quote.body.id, w.trade.id);
    expect(during.status).toBe(200);
    expect(await lineOf(quote.body.id)).toEqual({
      list: 600,
      net: 600,
      tradePercent: null,
      tierId: null,
    });

    // Back to the walk-in, the sale ends, and it goes to the trade customer again.
    expect((await relink(quote.body.id, w.walkIn.id)).status).toBe(200);
    await endSale(sale.id);
    const after = await relink(quote.body.id, w.trade.id);
    expect(after.status).toBe(200);
    expect(after.body.repricing).toMatchObject({ repriced: 0 });
    expect(await lineOf(quote.body.id)).toEqual({
      list: 600,
      net: 600,
      tradePercent: null,
      tierId: null,
    });
    expect(await approvals()).toBe(0);
  });

  it("with the setting on, the same quote takes the tier off its sale price, after the sale too", async () => {
    const w = await world();
    const sale = await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);
    await tierOnSaleItems(true);
    const quote = await ring(w, w.walkIn.id, w.sofa.id, 600);
    expect(quote.status).toBe(201);
    await endSale(sale.id);

    const res = await relink(quote.body.id, w.trade.id);
    expect(res.status).toBe(200);
    expect(res.body.repricing).toMatchObject({ repriced: 1, kept: 0 });
    expect(await lineOf(quote.body.id)).toEqual({
      list: 600,
      net: 480,
      tradePercent: 20,
      tierId: w.designer.id,
    });
    expect(await approvals()).toBe(0);
  });

  it("a quote written at the regular price takes the tier when handed over during a sale", async () => {
    const w = await world();
    const quote = await ring(w, w.walkIn.id, w.sofa.id, 1000);
    expect(quote.status).toBe(201);
    await onSaleToday([{ productId: w.sofa.id, salePrice: 600 }]);

    const res = await relink(quote.body.id, w.trade.id);
    expect(res.status).toBe(200);
    expect(res.body.repricing).toMatchObject({ repriced: 1, kept: 0 });
    expect(await lineOf(quote.body.id)).toEqual({
      list: 1000,
      net: 800,
      tradePercent: 20,
      tierId: w.designer.id,
    });
    expect(await approvals()).toBe(0);
  });
});

describe("every writer records whether its list was a sale price", () => {
  const flags = (orderId: number) =>
    prisma.orderLineItem
      .findMany({ where: { salesOrderId: orderId }, orderBy: { lineNumber: "asc" } })
      .then((lines) => lines.map((l) => l.listOnSale));

  it("the register, add-line, replace, duplicate and a house call", async () => {
    const w = await world();
    await makeStaff("mia", "MANAGER");
    const regular = await ring(w, w.walkIn.id, w.sofa.id, 1000);
    expect(await flags(regular.body.id)).toEqual([false]);

    await onSaleToday([
      { productId: w.sofa.id, salePrice: 600 },
      { productId: w.visit.id, salePrice: 150 },
    ]);
    const atSale = await ring(w, w.walkIn.id, w.sofa.id, 600);
    expect(await flags(atSale.body.id)).toEqual([true]);

    const added = await call(
      addLine,
      { id: String(regular.body.id) },
      { productName: "Sofa", productId: w.sofa.id, quantity: 1, unitPrice: 600 },
    );
    expect(added.status).toBe(201);
    expect(await flags(regular.body.id)).toEqual([false, true]);

    // Replacing a regular-price line with no product keeps its list and its flag.
    const [first] = await prisma.orderLineItem.findMany({
      where: { salesOrderId: regular.body.id },
      orderBy: { lineNumber: "asc" },
    });
    const replaced = await call(
      lineRoute,
      { id: String(regular.body.id), lineItemId: String(first.id) },
      { action: "replace", replacement: { productName: "Custom sofa", unitPrice: 1000 } },
      "PUT",
    );
    expect(replaced.status).toBe(200);
    const replacement = await prisma.orderLineItem.findUniqueOrThrow({
      where: { id: replaced.body.replacementId },
    });
    expect({ list: Number(replacement.listPrice), onSale: replacement.listOnSale }).toEqual({
      list: 1000,
      onSale: false,
    });

    const settings = await getAppSettings();
    const copy = await prisma.$transaction((tx) =>
      duplicateOrder(tx, {
        orderId: atSale.body.id,
        actor: { email: "manager@example.com", displayName: "manager" },
        settings,
      }),
    );
    expect(await flags(copy.id)).toEqual([true]);

    const booked = await asStaff(
      houseCallsRoute,
      "mia",
      "POST",
      {},
      { customerId: String(w.walkIn.id) },
    );
    expect(booked.status).toBe(201);
    const visit = await prisma.orderLineItem.findFirstOrThrow({
      where: { productName: "HC-VISIT" },
      orderBy: { id: "desc" },
    });
    expect(visit.listOnSale).toBe(true);
  });
});
