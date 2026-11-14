// /app/__tests__/integration/tradeTierPricing.integration.test.ts
//
// GAP-06 part C: a customer's trade tier prices their lines (DECISIONS 61).
//
// Before: a TradeTier ("Designer, 20% off") could be given to a customer and
// nothing in pricing read it. The register priced a trade customer's sofa at
// retail; a cashier who typed the trade price was giving a 20% discount, which
// the store's policy (default 0%) sent to a manager's PIN on every trade sale.
//
// Now the tier is an entitlement a manager set: on each eligible line the
// policy measures a discount from the entitled price (lib/sales/discountApproval.ts
// catalogLinePolicies), the line still records its retail as listPrice, and it
// records the tier and its percent. Every writer that runs the policy applies
// it (rule 42), a quote changing hands is re-priced for its new customer, and a
// tier is given only by a manager, only while it is on, with a record of who.
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
import { hashPin } from "@/lib/auth/password";
import { tradePolicies } from "@/lib/sales/discountApproval";
import { entitledUnitPrice } from "@/lib/pricing/tradeTier";
import { duplicateOrder } from "@/lib/sales/duplicateOrder";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as addLine } from "@/pages/api/sales/orders/[id]/line-items";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as orderRoute } from "@/pages/api/sales/orders/[id]";
import { handler as tradeRoute } from "@/pages/api/customers/[id]/trade";
import { handler as vendorRoute } from "@/pages/api/vendors/[id]";
import settingsRoute from "@/pages/api/admin/settings/index";
import customersRoute from "@/pages/api/customers/index";
import productsRoute from "@/pages/api/products/index";
import tiersRoute from "@/pages/api/admin/trade-tiers/index";
import tierRoute from "@/pages/api/admin/trade-tiers/[id]";

const manager = { user: { email: "manager@example.com" } } as unknown as Session;
const NO_DISCOUNT = { holds: {} };
const CAN_DISCOUNT = { holds: { "sales.discount": true } };
const PIN = "4826";

interface TestRes {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes() {
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
  return res;
}

type Handler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: { holds: Record<string, boolean> },
) => unknown;

/** A route's exported handler, with a session and what the caller holds. */
async function call(
  handler: Handler,
  method: string,
  query: Record<string, string>,
  body: unknown,
  access = NO_DISCOUNT,
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const request = { method, query, body, cookies: {}, headers: {} } as any;
  await handler(request, res as unknown as NextApiResponse, manager, access);
  return res as TestRes;
}

/** A gated route's default export, as the signed-in staff member `who`. */
async function asStaff(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  who: string,
  method: string,
  body: unknown = {},
  query: Record<string, string> = {},
): Promise<TestRes> {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  const res = makeRes();
  await route(
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res as TestRes;
}

async function staff(key: string, roleKey: string, pin: string | null) {
  await prisma.user.create({ data: { id: key, email: `${key}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: key,
      email: `${key}@example.com`,
      displayName: key,
      role: roleKey as never,
      roleId: role.id,
      pinHash: pin ? hashPin(pin) : null,
    },
  });
}

/**
 * A store with the strictest policy (staff discount nothing on their own), a
 * $1,000 sofa from a vendor that allows trade discounts, a $500 chair from one
 * that doesn't, a 20% tier and a 30% one turned off, a trade customer on the
 * 20% tier, a walk-in, and a manager who approves with a PIN.
 */
async function world() {
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Harbor Works" } });
  const optedOut = await prisma.vendor.create({
    data: { name: "Cedar Lane", allowTradeDiscount: false },
  });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Seating", departmentId: department.id },
  });
  const product = (productNumber: string, vendorId: number, baseRetail: number) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId,
        departmentId: department.id,
        categoryId: category.id,
        baseRetail,
      },
    });
  const sofa = await product("SOFA-1", vendor.id, 1000);
  const ottoman = await product("OTTO-1", vendor.id, 250);
  const chair = await product("CHAIR-1", optedOut.id, 500);
  const designer = await prisma.tradeTier.create({
    data: { name: "Designer", discountPercent: 20 },
  });
  const retired = await prisma.tradeTier.create({
    data: { name: "Old contract", discountPercent: 30, isActive: false },
  });
  const trade = await prisma.customer.create({
    data: {
      firstName: "Tess",
      lastName: "Trade",
      isTradeAccount: true,
      tradeTierId: designer.id,
    },
  });
  const walkIn = await prisma.customer.create({ data: { firstName: "Walt", lastName: "In" } });
  const approver = await staff("manager", "GENERAL_MANAGER", PIN);
  return {
    store,
    vendor,
    optedOut,
    sofa,
    ottoman,
    chair,
    designer,
    retired,
    trade,
    walkIn,
    approver,
  };
}

type World = Awaited<ReturnType<typeof world>>;

interface Item {
  productId: number;
  unitPrice: number;
  quantity?: number;
  percentOff?: number;
  type?: "PRODUCT" | "CONFIGURED" | "CUSTOM";
}

/** A sale at the register for `customerId`. */
function ring(
  w: World,
  customerId: number | null,
  items: Item[],
  opts: { access?: typeof NO_DISCOUNT; approval?: unknown; extra?: object } = {},
) {
  return call(
    createFromCart,
    "POST",
    {},
    {
      storeLocation: w.store.name,
      customerId,
      items: items.map((i) => ({
        type: i.type,
        productId: i.productId,
        name: i.type && i.type !== "PRODUCT" ? "Made for you" : undefined,
        quantity: i.quantity ?? 1,
        unitPrice: i.unitPrice,
        discounts: i.percentOff ? [{ type: "PERCENT", value: i.percentOff }] : [],
      })),
      discountApproval: opts.approval,
      ...opts.extra,
    },
    opts.access,
  );
}

function linesOf(orderId: number) {
  return prisma.orderLineItem.findMany({
    where: { salesOrderId: orderId },
    orderBy: { lineNumber: "asc" },
  });
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

describe("the register prices a trade customer's lines at their tier", () => {
  it("the tier's price needs no PIN; the line keeps its retail and records the tier", async () => {
    const w = await world();
    const res = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 800 }]);
    expect(res.statusCode).toBe(201);
    const [line] = await linesOf(res.body.id);
    expect(money(line)).toEqual({ list: 1000, net: 800, tradePercent: 20, tierId: w.designer.id });
    expect(await prisma.orderChangeLog.count({ where: { changeType: "DISCOUNT_APPROVED" } })).toBe(
      0,
    );
  });

  it("a discount beyond the tier is measured from the tier's price, and needs the PIN", async () => {
    const w = await world();
    const refused = await ring(w, w.trade.id, [
      { productId: w.sofa.id, unitPrice: 800, percentOff: 10 },
    ]);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 10 });
    expect(await prisma.salesOrder.count()).toBe(0);

    const approved = await ring(
      w,
      w.trade.id,
      [{ productId: w.sofa.id, unitPrice: 800, percentOff: 10 }],
      {
        approval: { approverId: w.approver.id, pin: PIN },
      },
    );
    expect(approved.statusCode).toBe(201);
    const [line] = await linesOf(approved.body.id);
    expect(money(line)).toEqual({ list: 1000, net: 720, tradePercent: 20, tierId: w.designer.id });
  });

  it("a walk-in typing the trade price is giving a discount, as before", async () => {
    const w = await world();
    const res = await ring(w, w.walkIn.id, [{ productId: w.sofa.id, unitPrice: 800 }]);
    expect(res.statusCode).toBe(403);
    expect(res.body.percent).toBe(20);
  });

  it("a tier turned off grants nothing", async () => {
    const w = await world();
    await prisma.customer.update({
      where: { id: w.trade.id },
      data: { tradeTierId: w.retired.id },
    });
    const res = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 800 }]);
    expect(res.statusCode).toBe(403);
    expect(res.body.percent).toBe(20);
  });

  it("a vendor that opts out of trade discounts gets none", async () => {
    const w = await world();
    const refused = await ring(w, w.trade.id, [{ productId: w.chair.id, unitPrice: 400 }]);
    expect(refused.statusCode).toBe(403);
    expect(refused.body.percent).toBe(20);
    const atRetail = await ring(w, w.trade.id, [{ productId: w.chair.id, unitPrice: 500 }]);
    expect(atRetail.statusCode).toBe(201);
    const [line] = await linesOf(atRetail.body.id);
    expect(money(line)).toEqual({ list: 500, net: 500, tradePercent: null, tierId: null });
  });

  it("a configured line, a gift card and a delivery fee take no tier", async () => {
    const w = await world();
    const ledger = await prisma.gLAccount.create({
      data: { code: "4-4960", name: "Delivery Fees", accountType: "REVENUE" },
    });
    await prisma.systemGLMapping.create({
      data: { section: "POS_TRANSACTIONS", label: "Delivery Fee", glAccountId: ledger.id },
    });
    const res = await call(
      createFromCart,
      "POST",
      {},
      {
        storeLocation: w.store.name,
        customerId: w.trade.id,
        deliveryMethod: "DELIVERY",
        deliveryFee: 75,
        items: [
          {
            type: "CONFIGURED",
            productId: w.sofa.id,
            name: "Sofa in linen",
            vendor: w.vendor.name,
            quantity: 1,
            unitPrice: 1400,
          },
          { type: "GIFT_CARD", giftCardNumber: "GC-TRADE-1", amount: 100 },
        ],
      },
    );
    expect(res.statusCode).toBe(201);
    const lines = await linesOf(res.body.id);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect([line.productName, money(line).tradePercent, money(line).tierId]).toEqual([
        line.productName,
        null,
        null,
      ]);
    }
    const configured = lines.find((l) => l.productName === "Sofa in linen");
    expect(money(configured!)).toMatchObject({ list: 1400, net: 1400 });
    // Typed below its own price, a configured line is a discount for a trade customer too.
    const typed = await ring(w, w.trade.id, [
      { type: "CONFIGURED", productId: w.sofa.id, unitPrice: 1400, percentOff: 20 },
    ]);
    expect(typed.statusCode).toBe(403);
  });

  it("a return line on a trade customer's exchange records no tier", async () => {
    const w = await world();
    const res = await call(
      createFromCart,
      "POST",
      {},
      {
        storeLocation: w.store.name,
        customerId: w.trade.id,
        items: [
          { productId: w.sofa.id, quantity: 1, unitPrice: 800 },
          { productId: w.ottoman.id, quantity: -1, unitPrice: 200, isReturn: true },
        ],
      },
    );
    expect(res.statusCode).toBe(201);
    const [sold, returned] = await linesOf(res.body.id);
    expect(money(sold).tradePercent).toBe(20);
    expect(money(returned).tradePercent).toBeNull();
  });
});

describe("a sale price and the store's setting", () => {
  it("a tier leaves a sale price alone unless the store says it applies (read from the database)", async () => {
    const w = await world();
    const onSale = [{ productId: w.sofa.id, listUnit: 600, onSale: true }];
    const [off] = await tradePolicies(prisma, onSale, w.trade.id);
    expect(off).toEqual({ listUnit: 600, listOnSale: true, baselineUnit: 600, trade: null });

    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { pricing: { tradeDiscountOnSaleItems: true } },
    });
    const [on] = await tradePolicies(prisma, onSale, w.trade.id);
    expect(on).toEqual({
      listUnit: 600,
      listOnSale: true,
      baselineUnit: 480,
      trade: { tierId: w.designer.id, percent: 20 },
    });
    const [regular] = await tradePolicies(
      prisma,
      [{ productId: w.sofa.id, listUnit: 1000, onSale: false }],
      w.trade.id,
    );
    expect(regular.baselineUnit).toBe(800);
  });

  it("the setting saves through the settings screen's route, is recorded, and refuses a non-boolean", async () => {
    await staff("boss", "ADMIN", null);
    const saved = await asStaff(settingsRoute, "boss", "PUT", {
      pricing: { tradeDiscountOnSaleItems: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings.pricing.tradeDiscountOnSaleItems).toBe(true);
    invalidateAppSettingsCache();
    expect((await getAppSettings()).pricing.tradeDiscountOnSaleItems).toBe(true);
    const entry = await prisma.auditEntry.findFirstOrThrow({ where: { event: "SETTINGS_SAVED" } });
    expect(entry.summary).toBe("Changed: pricing.tradeDiscountOnSaleItems");

    const refused = await asStaff(settingsRoute, "boss", "PUT", {
      pricing: { tradeDiscountOnSaleItems: "yes" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toBe("pricing.tradeDiscountOnSaleItems must be true or false.");
  });
});

describe("every writer that runs the policy applies the tier", () => {
  /** A quote for the trade customer: the chair, from the vendor that opts out, at retail. */
  async function chairQuote(w: World) {
    const sale = await ring(w, w.trade.id, [{ productId: w.chair.id, unitPrice: 500 }]);
    expect(sale.statusCode).toBe(201);
    const [line] = await linesOf(sale.body.id);
    return { orderId: sale.body.id as number, line };
  }

  it("adding a line", async () => {
    const w = await world();
    const { orderId } = await chairQuote(w);
    const res = await call(
      addLine,
      "POST",
      { id: String(orderId) },
      { productName: "Sofa", productId: w.sofa.id, quantity: 2, unitPrice: 800 },
    );
    expect(res.statusCode).toBe(201);
    const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(money(line)).toEqual({ list: 1000, net: 1600, tradePercent: 20, tierId: w.designer.id });
  });

  it("replacing a line with a product the tier applies to", async () => {
    const w = await world();
    const { orderId, line } = await chairQuote(w);
    const res = await call(
      lineRoute,
      "PUT",
      { id: String(orderId), lineItemId: String(line.id) },
      {
        action: "replace",
        replacement: { productName: "Sofa", productId: w.sofa.id, unitPrice: 800 },
      },
    );
    expect(res.statusCode).toBe(200);
    const replacement = await prisma.orderLineItem.findUniqueOrThrow({
      where: { id: res.body.replacementId },
    });
    expect(money(replacement)).toEqual({
      list: 1000,
      net: 800,
      tradePercent: 20,
      tierId: w.designer.id,
    });
  });

  it("changing a tier-priced line's price: measured from what it recorded, and cleared above it", async () => {
    const w = await world();
    const sale = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 800 }]);
    const [line] = await linesOf(sale.body.id);
    const ids = { id: String(sale.body.id), lineItemId: String(line.id) };

    const below = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 760 });
    expect(below.statusCode).toBe(403);
    expect(below.body.percent).toBe(5);

    // The customer's tier is gone now; the line still sold under it.
    await prisma.customer.update({ where: { id: w.trade.id }, data: { tradeTierId: null } });
    const same = await call(lineRoute, "PUT", ids, {
      action: "update",
      unitPrice: 800,
      quantity: 1,
    });
    expect(same.statusCode).toBe(200);

    const above = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 900 });
    expect(above.statusCode).toBe(200);
    const after = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: line.id } });
    expect(money(after)).toEqual({ list: 1000, net: 900, tradePercent: null, tierId: null });
  });

  it("a tier-priced line raised above its trade price comes back to it with no PIN, and records its tier again", async () => {
    const w = await world();
    const sale = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 800 }]);
    const [line] = await linesOf(sale.body.id);
    const ids = { id: String(sale.body.id), lineItemId: String(line.id) };

    const raised = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 900 });
    expect(raised.statusCode).toBe(200);
    const back = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 800 });
    expect(back.statusCode).toBe(200);
    const after = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: line.id } });
    expect(money(after)).toEqual({ list: 1000, net: 800, tradePercent: 20, tierId: w.designer.id });
    // Below the trade price is still a discount.
    const below = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 760 });
    expect(below.statusCode).toBe(403);
    expect(below.body.percent).toBe(5);
  });

  it("duplicating an order prices the copy at the customer's tier today", async () => {
    const w = await world();
    const sale = await ring(w, w.walkIn.id, [
      { productId: w.sofa.id, unitPrice: 1000 },
      { productId: w.chair.id, unitPrice: 500 },
    ]);
    // The walk-in became a trade customer since.
    await prisma.customer.update({
      where: { id: w.walkIn.id },
      data: { isTradeAccount: true, tradeTierId: w.designer.id },
    });
    const settings = await getAppSettings();
    const copy = await prisma.$transaction((tx) =>
      duplicateOrder(tx, {
        orderId: sale.body.id,
        actor: { email: "manager@example.com", displayName: "manager" },
        settings,
      }),
    );
    const [sofa, chair] = await linesOf(copy.id);
    expect(money(sofa)).toEqual({ list: 1000, net: 800, tradePercent: 20, tierId: w.designer.id });
    expect(money(chair)).toEqual({ list: 500, net: 500, tradePercent: null, tierId: null });
  });
});

describe("a quote changing hands is priced for its new customer", () => {
  /** A walk-in's quote: a sofa at retail, and an ottoman someone typed a price on. */
  async function walkInQuote(w: World) {
    const sale = await ring(
      w,
      w.walkIn.id,
      [
        { productId: w.sofa.id, unitPrice: 1000 },
        { productId: w.ottoman.id, unitPrice: 225 },
      ],
      { access: CAN_DISCOUNT },
    );
    expect(sale.statusCode).toBe(201);
    return sale.body.id as number;
  }

  it("re-prices the lines still at their price, keeps the typed ones, and says so", async () => {
    const w = await world();
    const orderId = await walkInQuote(w);
    const res = await call(orderRoute, "PUT", { id: String(orderId) }, { customerId: w.trade.id });
    expect(res.statusCode).toBe(200);
    expect(res.body.repricing).toEqual({
      repriced: 1,
      kept: 1,
      message:
        "1 line re-priced for the new customer; 1 line with a price someone set kept as it was.",
    });
    const [sofa, ottoman] = await linesOf(orderId);
    expect(money(sofa)).toEqual({ list: 1000, net: 800, tradePercent: 20, tierId: w.designer.id });
    expect(money(ottoman)).toEqual({ list: 250, net: 225, tradePercent: null, tierId: null });
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { lineItemId: sofa.id, changeType: "PRICE_CHANGE" },
    });
    expect(log.reason).toBe("Customer changed: trade price (20% off)");

    // Back to the walk-in: the tier comes off again. The ottoman's typed $225
    // is above the Designer's $200 but 10% off the walk-in's $250, and nothing
    // records which customer it was set for -- so it is asked for again, and a
    // caller who may discount takes it back with no PIN.
    const asked = await call(
      orderRoute,
      "PUT",
      { id: String(orderId) },
      { customerId: w.walkIn.id },
    );
    expect(asked.statusCode).toBe(403);
    expect(asked.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 10 });
    const back = await call(
      orderRoute,
      "PUT",
      { id: String(orderId) },
      { customerId: w.walkIn.id },
      CAN_DISCOUNT,
    );
    expect(back.body.repricing.repriced).toBe(1);
    const [restored] = await linesOf(orderId);
    expect(money(restored)).toEqual({ list: 1000, net: 1000, tradePercent: null, tierId: null });
  });

  it("re-rates tax on the new prices, after re-pricing them", async () => {
    const w = await world();
    const district = await prisma.taxDistrict.create({
      data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
    });
    const group = await prisma.taxGroup.create({ data: { name: "Standard" } });
    await prisma.taxRule.create({
      data: { districtId: district.id, groupId: group.id, taxRate: 0.06, sortOrder: 0 },
    });
    await prisma.storeLocation.update({
      where: { id: w.store.id },
      data: { taxDistrictId: district.id },
    });
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { defaultTaxDistrictId: district.id },
    });
    invalidateAppSettingsCache();
    const orderId = await walkInQuote(w);
    const [before] = await linesOf(orderId);
    expect(Number(before.vatAmount)).toBe(60);

    const res = await call(orderRoute, "PUT", { id: String(orderId) }, { customerId: w.trade.id });
    expect(res.statusCode).toBe(200);
    const [sofa, ottoman] = await linesOf(orderId);
    expect(Number(sofa.netPrice)).toBe(800);
    // Tax on the trade price, not on the retail it was re-priced from.
    expect(Number(sofa.vatAmount)).toBe(48);
    expect(Number(ottoman.vatAmount)).toBe(13.5);
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(Number(order.totalTax)).toBe(61.5);
  });

  it("a kept line discounted below a trade price needs a manager when the new customer has no tier", async () => {
    const w = await world();
    // Staff may give 5% on their own: 1% below the trade price needs nobody.
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { discountLimitPercent: 5 },
    });
    const sale = await ring(w, w.trade.id, [
      { productId: w.sofa.id, unitPrice: 800, percentOff: 1 },
    ]);
    expect(sale.statusCode).toBe(201);
    const orderId = sale.body.id as number;
    const [line] = await linesOf(orderId);
    expect(money(line)).toEqual({ list: 1000, net: 792, tradePercent: 20, tierId: w.designer.id });

    // To the walk-in it is 20.8% off retail: past the limit, so a manager decides.
    const refused = await call(
      orderRoute,
      "PUT",
      { id: String(orderId) },
      { customerId: w.walkIn.id },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 20.8 });
    const unchanged = await prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(unchanged.customerId).toBe(w.trade.id);

    const approved = await call(
      orderRoute,
      "PUT",
      { id: String(orderId) },
      { customerId: w.walkIn.id, discountApproval: { approverId: w.approver.id, pin: PIN } },
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.body.repricing).toMatchObject({ repriced: 0, kept: 1 });
    // The price stays, the Designer tier comes off the line, and who approved it is recorded.
    const [kept] = await linesOf(orderId);
    expect(money(kept)).toEqual({ list: 1000, net: 792, tradePercent: null, tierId: null });
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { lineItemId: kept.id, changeType: "DISCOUNT_APPROVED" },
    });
    expect(log.newValue).toContain("20.8% off approved by manager");

    // A later edit is measured from the walk-in's price, not the Designer's.
    const ids = { id: String(orderId), lineItemId: String(kept.id) };
    const edit = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 800 });
    expect(edit.statusCode).toBe(403);
    expect(edit.body.percent).toBe(20);
  });

  it("a price above the trade price but below retail is a discount for a walk-in, and asks", async () => {
    const w = await world();
    // No discount without a manager; $801 is above the Designer's $800, so it needs none.
    const sale = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 801 }]);
    expect(sale.statusCode).toBe(201);
    const orderId = sale.body.id as number;
    const refused = await call(
      orderRoute,
      "PUT",
      { id: String(orderId) },
      { customerId: w.walkIn.id },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 19.9 });
    const [line] = await linesOf(orderId);
    expect(money(line)).toEqual({ list: 1000, net: 801, tradePercent: null, tierId: null });

    // Handed between two walk-ins, a price someone set is theirs: nothing to ask.
    const other = await prisma.customer.create({ data: { firstName: "Wren", lastName: "In" } });
    const walkInSale = await ring(w, w.walkIn.id, [{ productId: w.sofa.id, unitPrice: 900 }], {
      access: CAN_DISCOUNT,
    });
    const moved = await call(
      orderRoute,
      "PUT",
      { id: String(walkInSale.body.id) },
      { customerId: other.id },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.body.repricing).toMatchObject({ repriced: 0, kept: 1 });
  });

  it("re-prices nothing once money has touched the quote", async () => {
    const w = await world();
    const orderId = await walkInQuote(w);
    await prisma.payment.create({
      data: {
        salesOrderId: orderId,
        paymentDate: new Date(),
        paymentType: "CASH",
        paymentAmount: 100,
        status: "PENDING" as never,
      },
    });
    const res = await call(orderRoute, "PUT", { id: String(orderId) }, { customerId: w.trade.id });
    expect(res.statusCode).toBe(200);
    expect(res.body.repricing).toBeUndefined();
    const [sofa] = await linesOf(orderId);
    expect(money(sofa)).toEqual({ list: 1000, net: 1000, tradePercent: null, tierId: null });
  });
});

describe("giving a customer a tier", () => {
  const put = (customerId: number, body: object) =>
    call(tradeRoute as unknown as Handler, "PUT", { id: String(customerId) }, body);

  it("refuses a tier that is turned off, and records nothing", async () => {
    const w = await world();
    const res = await put(w.walkIn.id, { tradeTierId: w.retired.id, isTradeAccount: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "Old contract is turned off: turn it back on in Trade tiers before giving it to a customer.",
    );
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: w.walkIn.id } });
    expect([customer.tradeTierId, customer.isTradeAccount]).toEqual([null, false]);
    expect(await prisma.auditEntry.count({ where: { event: "TRADE_TIER_ASSIGNED" } })).toBe(0);
  });

  it("records who gave which tier, once per change, and saves a tier turned off since unchanged", async () => {
    const w = await world();
    const given = await put(w.walkIn.id, { tradeTierId: w.designer.id, isTradeAccount: true });
    expect(given.statusCode).toBe(200);
    expect(given.body.tradeTierId).toBe(w.designer.id);
    const entry = await prisma.auditEntry.findFirstOrThrow({
      where: { event: "TRADE_TIER_ASSIGNED" },
    });
    expect(entry).toMatchObject({
      actor: "manager@example.com",
      summary: "Walt In: trade tier none → Designer (20% off retail)",
      targetType: "customer",
      targetId: String(w.walkIn.id),
    });

    // Saved again as it stands -- even after the tier is turned off -- it is no change.
    await prisma.tradeTier.update({ where: { id: w.designer.id }, data: { isActive: false } });
    const resaved = await put(w.walkIn.id, { tradeTierId: w.designer.id, taxExemptNumber: "X-1" });
    expect(resaved.statusCode).toBe(200);
    expect(await prisma.auditEntry.count({ where: { event: "TRADE_TIER_ASSIGNED" } })).toBe(1);

    const removed = await put(w.walkIn.id, { tradeTierId: null });
    expect(removed.statusCode).toBe(200);
    expect(await prisma.auditEntry.count({ where: { event: "TRADE_TIER_ASSIGNED" } })).toBe(2);
  });

  it("refuses a tier id that isn't one", async () => {
    const w = await world();
    expect((await put(w.walkIn.id, { tradeTierId: "3" })).statusCode).toBe(400);
    expect((await put(w.walkIn.id, { tradeTierId: 99999 })).statusCode).toBe(400);
  });
});

describe("what the screens read", () => {
  it("the customer lookup carries an active tier, as numbers, and nothing for one turned off", async () => {
    const w = await world();
    await staff("boss", "ADMIN", null);
    await prisma.customer.create({
      data: { firstName: "Tom", lastName: "Trade", tradeTierId: w.retired.id },
    });
    const res = await asStaff(customersRoute, "boss", "GET", {}, { search: "Trade" });
    expect(res.statusCode).toBe(200);
    const byName = new Map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.body.data.map((c: any) => [c.firstName, c.tradeTier]),
    );
    expect(byName.get("Tess")).toEqual({
      id: w.designer.id,
      name: "Designer",
      discountPercent: 20,
    });
    expect(byName.get("Tom")).toBeNull();
  });

  it("the product search says which products a tier may discount", async () => {
    const w = await world();
    await staff("boss", "ADMIN", null);
    const res = await asStaff(productsRoute, "boss", "GET", {}, {});
    expect(res.statusCode).toBe(200);
    const eligible = new Map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.body.products.map((p: any) => [p.id, p.tradeEligible]),
    );
    expect(eligible.get(w.sofa.id)).toBe(true);
    expect(eligible.get(w.chair.id)).toBe(false);
  });

  it("a protection plan and a made-to-order product take no tier", async () => {
    const w = await world();
    const plans = await prisma.category.create({
      data: { name: "Protection", departmentId: w.sofa.departmentId },
    });
    const plan = await prisma.product.create({
      data: {
        productNumber: "PLAN-5",
        name: "5-year plan",
        vendorId: w.vendor.id,
        departmentId: w.sofa.departmentId,
        categoryId: plans.id,
        baseRetail: 200,
      },
    });
    await prisma.commissionPlan.create({
      data: {
        name: "Plans",
        kind: "PROTECTION_PLAN",
        rules: { create: [{ label: "Plans", categoryId: plans.id }] },
      },
    });
    const made = await prisma.product.update({
      where: { id: w.ottoman.id },
      data: { madeToOrder: true },
    });
    const policies = await tradePolicies(
      prisma,
      [
        { productId: plan.id, listUnit: 200, onSale: false },
        { productId: made.id, listUnit: 250, onSale: false },
        { productId: w.sofa.id, listUnit: 1000, onSale: false },
      ],
      w.trade.id,
    );
    expect(policies.map((p) => p.trade?.percent ?? null)).toEqual([null, null, 20]);
  });

  it("a vendor's trade discounts are switched on the vendor, and who switched them is recorded", async () => {
    const w = await world();
    const patch = (allowTradeDiscount: boolean) =>
      call(
        vendorRoute as unknown as Handler,
        "PATCH",
        { id: String(w.vendor.id) },
        {
          allowTradeDiscount,
        },
      );
    expect((await patch(false)).statusCode).toBe(200);
    expect((await patch(false)).statusCode).toBe(200);
    const entries = await prisma.auditEntry.findMany({
      where: { event: "VENDOR_TRADE_DISCOUNT_CHANGED" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      summary: "Harbor Works: trade discounts don't apply",
      targetType: "vendor",
      targetId: String(w.vendor.id),
    });
    const refused = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 800 }]);
    expect(refused.statusCode).toBe(403);
  });
});

describe("a tier's percent is the one its lines record", () => {
  it("a 33.333% tier prices and records 33.33, so its lines are re-priced and edited as written", async () => {
    const w = await world();
    // Saved before the trade tiers routes refused more than two places.
    const third = await prisma.tradeTier.create({
      data: { name: "A third", discountPercent: "33.333" },
    });
    await prisma.customer.update({ where: { id: w.trade.id }, data: { tradeTierId: third.id } });
    const sale = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: 666.7 }]);
    expect(sale.statusCode).toBe(201);
    const orderId = sale.body.id as number;
    const [line] = await linesOf(orderId);
    expect(money(line)).toEqual({ list: 1000, net: 666.7, tradePercent: 33.33, tierId: third.id });

    // The same price again is no discount.
    const ids = { id: String(orderId), lineItemId: String(line.id) };
    const same = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 666.7 });
    expect(same.statusCode).toBe(200);
    expect(
      money(await prisma.orderLineItem.findUniqueOrThrow({ where: { id: line.id } })),
    ).toMatchObject({ tradePercent: 33.33, tierId: third.id });

    // Handed to the walk-in, the line is at its trade price as written: it goes back to retail.
    const res = await call(orderRoute, "PUT", { id: String(orderId) }, { customerId: w.walkIn.id });
    expect(res.statusCode).toBe(200);
    expect(res.body.repricing).toMatchObject({ repriced: 1, kept: 0 });
    const [restored] = await linesOf(orderId);
    expect(money(restored)).toEqual({ list: 1000, net: 1000, tradePercent: null, tierId: null });
  });

  it("a tier too small to record takes nothing off, and the sale goes through", async () => {
    const w = await world();
    const tiny = await prisma.tradeTier.create({
      data: { name: "Tiny", discountPercent: "0.004" },
    });
    await prisma.customer.update({ where: { id: w.trade.id }, data: { tradeTierId: tiny.id } });
    // The price the register sends: the helper's entitled price for this tier.
    const sent = entitledUnitPrice({
      effectiveRetail: 1000,
      onSale: false,
      tier: tiny,
      vendorAllows: true,
      settings: { tradeDiscountOnSaleItems: false },
    }).price as number;
    const res = await ring(w, w.trade.id, [{ productId: w.sofa.id, unitPrice: sent }]);
    expect(res.statusCode).toBe(201);
    const [line] = await linesOf(res.body.id);
    expect(money(line)).toEqual({ list: 1000, net: 1000, tradePercent: null, tierId: null });
  });
});

describe("making and changing a tier", () => {
  it("is recorded, refuses more places than a line records, and takes Apply discounts to move money", async () => {
    const w = await world();
    await staff("boss", "ADMIN", null);
    await staff("buyer", "BUYER", null);

    const made = await asStaff(tiersRoute, "boss", "POST", {
      name: "Architect",
      discountPercent: 15,
    });
    expect(made.statusCode).toBe(201);
    const odd = await asStaff(tiersRoute, "boss", "POST", {
      name: "Third",
      discountPercent: 33.333,
    });
    expect(odd.statusCode).toBe(400);
    expect(odd.body.error).toBe("Discount can have at most two decimal places");

    const at = (who: string, body: object, id = w.designer.id) =>
      asStaff(tierRoute, who, "PUT", body, { id: String(id) });
    // A buyer keeps the catalog but gives no discounts: renaming is theirs, the percent isn't.
    const buyerRaise = await at("buyer", { discountPercent: 100 });
    expect(buyerRaise.statusCode).toBe(403);
    expect(
      Number(
        (await prisma.tradeTier.findUniqueOrThrow({ where: { id: w.designer.id } }))
          .discountPercent,
      ),
    ).toBe(20);
    expect(
      (await asStaff(tiersRoute, "buyer", "POST", { name: "Mine", discountPercent: 50 }))
        .statusCode,
    ).toBe(403);
    expect((await at("buyer", { isActive: true }, w.retired.id)).statusCode).toBe(403);
    expect((await at("buyer", { name: "Interior designer" })).statusCode).toBe(200);

    expect((await at("boss", { discountPercent: 25 })).statusCode).toBe(200);
    expect((await at("boss", { discountPercent: 12.345 })).statusCode).toBe(400);
    const off = await asStaff(tierRoute, "buyer", "DELETE", {}, { id: String(w.designer.id) });
    expect(off.statusCode).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { event: "TRADE_TIER_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => [e.actor, e.summary])).toEqual([
      ["boss@example.com", "Trade tier Architect made: 15% off retail"],
      ["boss@example.com", "Trade tier Interior designer: 20% off retail → 25% off retail"],
      ["buyer@example.com", "Trade tier Interior designer: turned off"],
    ]);
  });
});
