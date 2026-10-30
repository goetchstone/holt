// /app/__tests__/integration/discountPolicy.integration.test.ts
//
// GAP-06: a discount follows the store's policy, and a manager approves one
// with their PIN (lib/sales/discountApproval.ts).
//
// Before: "Apply discounts" (sales.discount) was in the permission catalog and
// no route checked it. Anyone at the register could take any amount off, type
// any price, or waive delivery, and the order kept no list price, so nothing
// could show what was given away.
//
// Owner, 2026-10-30: how a store runs discounts is its own business, and the
// default is locked down. So a role holding the permission discounts freely;
// everyone else up to AppSettings.discountLimitPercent (default 0); above it a
// manager approves with their PIN.
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
import { hashPin } from "@/lib/auth/password";
import { PIN_MAX_ATTEMPTS } from "@/lib/sales/discountApproval";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as addLine } from "@/pages/api/sales/orders/[id]/line-items";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as feeRoute } from "@/pages/api/sales/orders/[id]/delivery-fee";
import { handler as approversRoute } from "@/pages/api/sales/discount-approvers";
import { handler as printRoute } from "@/pages/api/print/order/[id]";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import settingsRoute from "@/pages/api/admin/settings/index";

const designer = { user: { email: "designer@example.com" } } as unknown as Session;
const NO_DISCOUNT = { holds: {} };
const CAN_DISCOUNT = { holds: { "sales.discount": true } };

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

type Handler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: { holds: Record<string, boolean> },
) => unknown;

async function call(
  handler: Handler,
  method: string,
  query: Record<string, string>,
  body: unknown,
  access = NO_DISCOUNT,
) {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const request = { method, query, body, cookies: {}, headers: {} } as any;
  await handler(request, res, designer, access);
  return res;
}

const PIN = "4826";

async function staff(key: string, roleKey: string, pin: string | null) {
  await prisma.user.create({ data: { id: key, email: `${key}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: key,
      email: `${key}@example.com`,
      displayName: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: roleKey as any,
      roleId: role.id,
      pinHash: pin ? hashPin(pin) : null,
    },
  });
}

/** A store, a $1,000 sofa, a manager who may approve, and a designer who may not. */
async function world(opts: { limit?: number } = {}) {
  await prisma.appSettings.update({
    where: { organizationId: DEFAULT_ORG_ID },
    data: { discountLimitPercent: opts.limit ?? 0 },
  });
  invalidateAppSettingsCache();
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
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
  const manager = await staff("manager", "GENERAL_MANAGER", PIN);
  const designerWithPin = await staff("designer", "DESIGNER", PIN);
  return { store, sofa, manager, designerWithPin };
}

type World = Awaited<ReturnType<typeof world>>;

/** One sofa at the register, with these item discounts or this typed price. */
function ring(
  w: World,
  opts: {
    unitPrice?: number;
    percentOff?: number;
    approval?: unknown;
    access?: typeof NO_DISCOUNT;
  } = {},
) {
  return call(
    createFromCart,
    "POST",
    {},
    {
      storeLocation: w.store.name,
      items: [
        {
          productId: w.sofa.id,
          quantity: 1,
          unitPrice: opts.unitPrice ?? 1000,
          discounts: opts.percentOff ? [{ type: "PERCENT", value: opts.percentOff }] : [],
        },
      ],
      discountApproval: opts.approval,
    },
    opts.access,
  );
}

async function attempts(staffId: number) {
  return prisma.staffMember.findUniqueOrThrow({
    where: { id: staffId },
    select: { pinFailedAttempts: true, pinLockedUntil: true },
  });
}

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

describe("the register follows the store's discount policy", () => {
  it("locked down by default: any discount needs a manager, and nothing is written", async () => {
    const w = await world();
    const res = await ring(w, { percentOff: 10 });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "DISCOUNT_APPROVAL_REQUIRED", percent: 10, limit: 0 });
    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("a manager's PIN approves it: the sale is written, with its list price and who approved", async () => {
    const w = await world();
    const res = await ring(w, {
      percentOff: 10,
      approval: { approverId: w.manager.id, pin: PIN },
    });
    expect(res.statusCode).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: res.body.id },
    });
    expect([Number(line.listPrice), Number(line.netPrice)]).toEqual([1000, 900]);
    const log = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: res.body.id, changeType: "DISCOUNT_APPROVED" },
    });
    expect(log.newValue).toBe(`10% off approved by manager (staff #${w.manager.id})`);
  });

  it("a price typed below retail is a discount too; above it is not", async () => {
    const w = await world();
    const typed = await ring(w, { unitPrice: 800 });
    expect(typed.statusCode).toBe(403);
    expect(typed.body.percent).toBe(20);
    expect((await ring(w, { unitPrice: 1200 })).statusCode).toBe(201);
  });

  it("a store's limit lets staff give up to it on their own", async () => {
    const w = await world({ limit: 15 });
    expect((await ring(w, { percentOff: 15 })).statusCode).toBe(201);
    const over = await ring(w, { percentOff: 16 });
    expect(over.statusCode).toBe(403);
    expect(over.body).toMatchObject({ percent: 16, limit: 15 });
  });

  it("a role holding Apply discounts gives any discount without asking", async () => {
    const w = await world();
    expect((await ring(w, { percentOff: 40, access: CAN_DISCOUNT })).statusCode).toBe(201);
  });

  it("only someone who holds the permission can approve, whatever their PIN", async () => {
    const w = await world();
    const res = await ring(w, {
      percentOff: 10,
      approval: { approverId: w.designerWithPin.id, pin: PIN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("That person can't approve discounts.");
    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("a manager's PIN", () => {
  it("a wrong PIN is refused, and the try counts though the sale was refused", async () => {
    const w = await world();
    const res = await ring(w, {
      percentOff: 10,
      approval: { approverId: w.manager.id, pin: "0000" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("That PIN isn't right.");
    expect(await prisma.salesOrder.count()).toBe(0);
    expect((await attempts(w.manager.id)).pinFailedAttempts).toBe(1);
  });

  it("locks after five wrong tries, and then refuses even the right one", async () => {
    const w = await world();
    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) {
      await ring(w, { percentOff: 10, approval: { approverId: w.manager.id, pin: "0000" } });
    }
    const fifth = await ring(w, {
      percentOff: 10,
      approval: { approverId: w.manager.id, pin: "0000" },
    });
    expect(fifth.statusCode).toBe(423);
    expect((await attempts(w.manager.id)).pinLockedUntil).not.toBeNull();

    const right = await ring(w, {
      percentOff: 10,
      approval: { approverId: w.manager.id, pin: PIN },
    });
    expect(right.statusCode).toBe(423);
    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("a right PIN clears the count of wrong ones", async () => {
    const w = await world();
    await ring(w, { percentOff: 10, approval: { approverId: w.manager.id, pin: "0000" } });
    await ring(w, { percentOff: 10, approval: { approverId: w.manager.id, pin: PIN } });
    expect((await attempts(w.manager.id)).pinFailedAttempts).toBe(0);
  });

  it("the approvers list is the active staff who hold the permission and have a PIN", async () => {
    const w = await world();
    await staff("gm-without-pin", "GENERAL_MANAGER", null);
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await approversRoute({ method: "GET", query: {} } as any, res);
    expect(res.body).toEqual([{ id: w.manager.id, displayName: "manager" }]);
  });
});

describe("every route that can sell below list follows it", () => {
  async function orderWithSofa(w: World) {
    const sale = await ring(w, { access: CAN_DISCOUNT });
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: sale.body.id },
    });
    return { orderId: sale.body.id as number, line };
  }

  it("changing a line's price below its list", async () => {
    const w = await world();
    const { orderId, line } = await orderWithSofa(w);
    const ids = { id: String(orderId), lineItemId: String(line.id) };
    const refused = await call(lineRoute, "PUT", ids, { action: "update", unitPrice: 700 });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.percent).toBe(30);
    expect(
      Number((await prisma.orderLineItem.findUniqueOrThrow({ where: { id: line.id } })).netPrice),
    ).toBe(1000);

    const approved = await call(lineRoute, "PUT", ids, {
      action: "update",
      unitPrice: 700,
      discountApproval: { approverId: w.manager.id, pin: PIN },
    });
    expect(approved.statusCode).toBe(200);
    expect(
      await prisma.orderChangeLog.count({
        where: { salesOrderId: orderId, changeType: "DISCOUNT_APPROVED", lineItemId: line.id },
      }),
    ).toBe(1);
  });

  it("replacing a line at a lower price", async () => {
    const w = await world();
    const { orderId, line } = await orderWithSofa(w);
    const res = await call(
      lineRoute,
      "PUT",
      { id: String(orderId), lineItemId: String(line.id) },
      { action: "replace", replacement: { productName: "Other sofa", unitPrice: 500 } },
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.percent).toBe(50);
  });

  it("adding a product below its retail", async () => {
    const w = await world();
    const { orderId } = await orderWithSofa(w);
    const res = await call(
      addLine,
      "POST",
      { id: String(orderId) },
      { productName: "Camelback Sofa", productId: w.sofa.id, quantity: 1, unitPrice: 900 },
    );
    expect(res.statusCode).toBe(403);
    expect(await prisma.orderLineItem.count({ where: { salesOrderId: orderId } })).toBe(1);
  });

  it("cutting a delivery fee below its zone's", async () => {
    const w = await world();
    const ledger = await prisma.gLAccount.create({
      data: { code: "4-4960", name: "Delivery Fees", accountType: "REVENUE" },
    });
    await prisma.systemGLMapping.create({
      data: { section: "POS_TRANSACTIONS", label: "Delivery Fee", glAccountId: ledger.id },
    });
    await prisma.deliveryZone.create({
      data: { name: "Local", baseFee: 100, zipCodes: { create: [{ zipCode: "06880" }] } },
    });
    const customer = await prisma.customer.create({
      data: {
        firstName: "Ada",
        lastName: "Lane",
        addresses: { create: [{ address1: "1 Main", city: "W", state: "CT", zip: "06880" }] },
      },
    });
    const sale = await call(
      createFromCart,
      "POST",
      {},
      {
        storeLocation: w.store.name,
        customerId: customer.id,
        deliveryMethod: "DELIVERY",
        deliveryFee: 100,
        items: [{ productId: w.sofa.id, quantity: 1, unitPrice: 1000 }],
      },
    );
    expect(sale.statusCode).toBe(201);
    const fee = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: sale.body.id },
      select: { deliveryFeeLine: { select: { listPrice: true } } },
    });
    expect(Number(fee.deliveryFeeLine?.listPrice)).toBe(100);

    const cut = await call(feeRoute, "PUT", { id: String(sale.body.id) }, { amount: 60 });
    expect(cut.statusCode).toBe(403);
    expect(cut.body.percent).toBe(40);
    const waivedAtRegister = await call(
      createFromCart,
      "POST",
      {},
      {
        storeLocation: w.store.name,
        customerId: customer.id,
        deliveryMethod: "DELIVERY",
        items: [{ productId: w.sofa.id, quantity: 1, unitPrice: 1000 }],
      },
    );
    expect(waivedAtRegister.statusCode).toBe(403);
    expect(waivedAtRegister.body.percent).toBe(100);
  });
});

describe("the printed receipt and invoice", () => {
  it("total only active lines and counted payments, with each line's list price", async () => {
    const w = await world();
    const sale = await ring(w, { percentOff: 10, access: CAN_DISCOUNT });
    const orderId = sale.body.id as number;
    await prisma.orderLineItem.createMany({
      data: [
        {
          salesOrderId: orderId,
          lineNumber: 5,
          productName: "Cancelled",
          orderedQuantity: 1,
          netPrice: 300,
          cost: 0,
          lineItemStatus: "CANCELLED",
        },
        {
          salesOrderId: orderId,
          lineNumber: 6,
          productName: "Replaced",
          orderedQuantity: 1,
          netPrice: 200,
          cost: 0,
          lineItemStatus: "REPLACED",
        },
      ],
    });
    await prisma.payment.createMany({
      data: [
        {
          salesOrderId: orderId,
          paymentDate: new Date(),
          paymentType: "Cash",
          method: "CASH",
          paymentAmount: 500,
          status: "COMPLETED",
        },
        {
          salesOrderId: orderId,
          paymentDate: new Date(),
          paymentType: "Card",
          method: "CARD",
          paymentAmount: 400,
          status: "VOIDED",
        },
        {
          salesOrderId: orderId,
          paymentDate: new Date(),
          paymentType: "Cash",
          method: "CASH",
          paymentAmount: 50,
          status: "COMPLETED",
          isRefund: true,
        },
      ],
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await printRoute({ method: "GET", query: { id: String(orderId) } } as any, res);
    expect(res.body.lineItems).toEqual([
      expect.objectContaining({ productName: "Camelback Sofa", netPrice: 900, listPrice: 1000 }),
    ]);
    expect(res.body.payments.map((p: { paymentAmount: number }) => p.paymentAmount)).toEqual([
      500, -50,
    ]);
  });
});

describe("setting a register PIN (My Account)", () => {
  const caller = (userId: string) =>
    createCallerFactory(appRouter)({
      userId,
      userEmail: `${userId}@example.com`,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    });

  it("proves the password, stores only a hash, and clears a lockout", async () => {
    const w = await world();
    await prisma.staffMember.update({
      where: { id: w.manager.id },
      data: {
        passwordHash: hashPassword("a long enough password"),
        pinFailedAttempts: 3,
        pinLockedUntil: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      caller("manager").account.setPin({ currentPassword: "wrong password!!", pin: "9753" }),
    ).rejects.toMatchObject({ message: "Current password is incorrect." });
    await expect(
      caller("manager").account.setPin({ currentPassword: "a long enough password", pin: "12" }),
    ).rejects.toBeTruthy();

    await caller("manager").account.setPin({
      currentPassword: "a long enough password",
      pin: "9753",
    });
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: w.manager.id } });
    expect(row.pinHash).not.toContain("9753");
    expect(verifyPassword("9753", row.pinHash)).toBe(true);
    expect([row.pinFailedAttempts, row.pinLockedUntil]).toEqual([0, null]);
  });
});

describe("the store's discount limit (Settings)", () => {
  it("is a whole percent from 0 to 100, saved for the register to use", async () => {
    await world();
    await staff("owner", "ADMIN", null);
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: "owner", email: "owner@example.com" },
    });
    const put = async (body: unknown) => {
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await settingsRoute({ method: "PUT", query: {}, body, cookies: {}, headers: {} } as any, res);
      return res;
    };
    for (const bad of [101, -1, 12.5, "10"]) {
      expect((await put({ discountLimitPercent: bad })).statusCode).toBe(400);
    }
    const saved = await put({ discountLimitPercent: 20 });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings.discountLimitPercent).toBe(20);
  });
});
