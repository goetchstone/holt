// __tests__/integration/cancelOrder.integration.test.ts
//
// Owner, 2026-11-06: "if an order has a payment, then we would be cancelling the order
// and either returning the payment or leaving a credit on account... the only thing that
// might be deletable is a quote", and "a sale can be processed without a payment if the
// store is configured to allow it". Real routes and database; only the session readers
// and the card processor's call are stood in for.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));

import { Prisma } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, getAppSettings, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { getBalance } from "@/lib/customerCredit";
import { calculateOrderBalance, onPaymentReceived, recordPayment } from "@/lib/paymentService";
import { markHandedOver } from "@/lib/fulfilment/handover";
import { receiptOrderId } from "@/lib/inventory/receiving";
import { raiseSpecialOrderPos } from "@/lib/sales/salePos";
import { stripeProvider } from "@/lib/payments/stripeProvider";
import { stockAt } from "../helpers/stock";
import { holdRows, waitForLockWaits } from "../helpers/locks";
import cancelRoute from "@/pages/api/sales/orders/[id]/cancel";
import lineRoute from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import createPoRoute from "@/pages/api/sales/orders/[id]/create-po";
import paymentLinkRoute from "@/pages/api/stripe/send-payment-link";
import orderRoute from "@/pages/api/sales/orders/[id]";
import dispatchRoute from "@/pages/api/sales/orders/[id]/dispatch";
import settingsRoute from "@/pages/api/admin/settings/index";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(
  route: Route,
  who: string,
  {
    method = "POST",
    query = {},
    body = {},
  }: { method?: string; query?: Record<string, string>; body?: object } = {},
) {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: payload as Record<string, any> };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: roleKey as never,
      roleId: role.id,
      defaultStore: "Main Street",
    },
  });
}

let world: Awaited<ReturnType<typeof makeWorld>>;

async function makeWorld() {
  const vendor = await prisma.vendor.create({ data: { name: "Northfield" } });
  const department = await prisma.department.create({ data: { name: "Living Room" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "S-1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Main Street", code: "MS", type: "STORE" },
  });
  return { product, store };
}

let orderCount = 0;

async function makeOrder({
  status = "ORDER",
  customer = true,
  total = 1000,
}: { status?: "ORDER" | "QUOTE"; customer?: boolean; total?: number } = {}) {
  orderCount += 1;
  const buyer = customer
    ? await prisma.customer.create({ data: { firstName: "Ada", lastName: `Lane${orderCount}` } })
    : null;
  const order = await prisma.salesOrder.create({
    data: {
      orderno: `SO-${orderCount}`,
      status,
      customerId: buyer?.id,
      storeLocation: world.store.name,
      storeLocationId: world.store.id,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: world.product.id,
            productName: "Sofa",
            orderedQuantity: 1,
            netPrice: total,
            cost: 400,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
    include: { lineItems: true },
  });
  return { order, buyer };
}

async function pay(salesOrderId: number, amount: number, extra: Record<string, unknown> = {}) {
  return prisma.payment.create({
    data: {
      salesOrderId,
      paymentDate: new Date(),
      paymentType: "Cash",
      method: "CASH",
      paymentAmount: amount,
      status: "COMPLETED",
      ...extra,
    } as never,
  });
}

/** A special order's PO, as the sale raised it, in the state asked for. */
async function makePo(
  order: { id: number; lineItems: { id: number }[] },
  status: "DRAFT" | "SUBMITTED" | "CONFIRMED" | "RECEIVED_PARTIAL" | "RECEIVED_FULL",
  { received = 0 }: { received?: number } = {},
) {
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-${order.id}-${status}`,
      vendorId: world.product.vendorId,
      salesOrderId: order.id,
      status,
      ...(status === "DRAFT" || status === "SUBMITTED" ? {} : { vendorAckNumber: "ACK-1" }),
      lineItems: {
        create: [
          {
            orderLineItemId: order.lineItems[0].id,
            productId: world.product.id,
            partNo: "S-1",
            productName: "Sofa",
            orderedQuantity: 2,
            unitCost: 400,
          },
        ],
      },
    } as never,
    include: { lineItems: true },
  });
  if (received > 0) {
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderId: po.id,
        purchaseOrderItemId: (po as unknown as { lineItems: { id: number }[] }).lineItems[0].id,
        quantityReceived: received,
        receiverUserId: "owner",
      } as never,
    });
  }
  return po;
}

const poOf = (id: number) =>
  prisma.purchaseOrder.findUniqueOrThrow({
    where: { id },
    include: { lineItems: true },
  });

const cancel = (id: number, body: object, who = "boss") =>
  call(cancelRoute, who, { query: { id: String(id) }, body });

const statusOf = async (id: number) =>
  (await prisma.salesOrder.findUniqueOrThrow({ where: { id } })).status;

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, appName: "Holt" } });
  invalidateAppSettingsCache();
  await makeStaff("owner", "SUPER_ADMIN");
  await makeStaff("boss", "ADMIN");
  await makeStaff("till", "REGISTER");
  world = await makeWorld();
  jest.restoreAllMocks();
});

describe("cancelling a sale with nothing paid", () => {
  it("cancels it, puts the stock back, and records who and why", async () => {
    const { order } = await makeOrder();
    await stockAt({
      productId: world.product.id,
      storeLocationId: world.store.id,
      quantity: 1,
      salesOrderId: order.id,
    });

    const res = await cancel(order.id, { reason: "Changed their mind" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: 0, credited: 0 });
    expect(await statusOf(order.id)).toBe("CANCELLED");
    const committed = await prisma.inventoryPosition.count({
      where: { productId: world.product.id, salesOrderId: order.id, quantity: { gt: 0 } },
    });
    expect(committed).toBe(0);
    const free = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: world.product.id, salesOrderId: null },
    });
    expect(Number(free.quantity)).toBe(1);
    expect(
      await prisma.orderChangeLog.findFirstOrThrow({
        where: { salesOrderId: order.id, changeType: "STATUS_CHANGE" },
      }),
    ).toMatchObject({
      previousValue: "ORDER",
      newValue: "CANCELLED",
      reason: "Changed their mind",
      changedBy: "boss@example.com",
    });
  });

  it("needs a reason", async () => {
    const { order } = await makeOrder();
    const res = await cancel(order.id, { reason: "  " });
    expect(res.status).toBe(400);
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("cancels a quote the same way", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    expect((await cancel(order.id, { reason: "No sale" })).status).toBe(200);
    expect(await statusOf(order.id)).toBe("CANCELLED");
  });

  it("doesn't ask a role that can't refund, since there's nothing to give back", async () => {
    await makeStaff("lead", "MANAGER");
    await prisma.rolePermission.deleteMany({
      where: { role: { key: "MANAGER" }, permission: "payment.refund" },
    });
    await prisma.role.updateMany({ where: { key: "MANAGER" }, data: { grantsCustomized: true } });
    invalidateRoleGrantCache();
    const { order } = await makeOrder();
    expect((await cancel(order.id, { reason: "No sale" }, "lead")).status).toBe(200);
  });
});

describe("what the screen is told", () => {
  it("says what's held on each payment, less what's already gone back", async () => {
    const { order } = await makeOrder();
    const first = await pay(order.id, 300);
    await pay(order.id, 200, { paymentType: "Check", method: "CHECK" });
    await pay(order.id, 50, { status: "VOIDED" });
    await pay(order.id, 100, {
      isRefund: true,
      originalPaymentId: first.id,
      paymentType: "Cash",
    });

    const res = await call(cancelRoute, "boss", {
      method: "GET",
      query: { id: String(order.id) },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ held: 400, canCredit: true, canRefund: true, problem: null });
    expect(
      res.body.payments.map((p: { label: string; amount: number }) => [p.label, p.amount]),
    ).toEqual([
      ["Cash", 200],
      ["Check", 200],
    ]);
  });

  it("takes credit already given back off what's held", async () => {
    const { order, buyer } = await makeOrder();
    await pay(order.id, 300);
    await pay(order.id, 100, {
      isRefund: true,
      method: "STORE_CREDIT",
      paymentType: "Store Credit",
      customerId: buyer?.id,
    });
    const res = await call(cancelRoute, "boss", {
      method: "GET",
      query: { id: String(order.id) },
    });
    expect(res.body.held).toBe(200);
  });

  it("can't offer credit with no customer to hold it", async () => {
    const { order } = await makeOrder({ customer: false });
    await pay(order.id, 100);
    const res = await call(cancelRoute, "boss", {
      method: "GET",
      query: { id: String(order.id) },
    });
    expect(res.body.canCredit).toBe(false);
  });
});

describe("cancelling a sale with money on it", () => {
  it("won't cancel until it's told where the money goes", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 500);
    const res = await cancel(order.id, { reason: "No sale" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("money on this order");
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("refuses a destination it doesn't know", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 500);
    const res = await cancel(order.id, { reason: "No sale", destination: "POCKET" });
    expect(res.status).toBe(400);
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("puts each payment back the way it was taken, and leaves nothing held", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 300);
    await pay(order.id, 200, { paymentType: "Check", method: "CHECK" });

    const res = await cancel(order.id, {
      reason: "Changed their mind",
      destination: "ORIGINAL_PAYMENT",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: 500, credited: 0 });
    expect(await statusOf(order.id)).toBe("CANCELLED");
    const refunds = await prisma.payment.findMany({
      where: { salesOrderId: order.id, isRefund: true },
      orderBy: { id: "asc" },
    });
    expect(refunds.map((r) => [r.method, Number(r.paymentAmount), r.status])).toEqual([
      ["CASH", 300, "COMPLETED"],
      ["CHECK", 200, "COMPLETED"],
    ]);
    expect(refunds.every((r) => r.createdBy === "boss@example.com")).toBe(true);
    expect((await calculateOrderBalance(order.id)).totalPaid).toBe(0);
    const history = await prisma.orderChangeLog.findMany({
      where: { salesOrderId: order.id, changeType: "REFUND_ISSUED" },
    });
    expect(history.map((h) => [h.newValue, h.reason, h.changedBy])).toEqual([
      ["300", "Changed their mind", "boss@example.com"],
      ["200", "Changed their mind", "boss@example.com"],
    ]);
  });

  it("leaves it as credit on the customer's account, all in one go", async () => {
    const { order, buyer } = await makeOrder();
    await pay(order.id, 300);
    await pay(order.id, 200, { paymentType: "Check", method: "CHECK" });

    const res = await cancel(order.id, {
      reason: "Will buy later",
      destination: "STORE_CREDIT",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: 0, credited: 500 });
    expect(await statusOf(order.id)).toBe("CANCELLED");
    expect(await getBalance(buyer!.id)).toBe(500);
    expect((await calculateOrderBalance(order.id)).totalPaid).toBe(0);
    const history = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "CREDIT_ISSUED" },
    });
    expect(history).toMatchObject({ newValue: "500", reason: "Will buy later" });
  });

  it("won't leave credit with no customer, and changes nothing", async () => {
    const { order } = await makeOrder({ customer: false });
    await pay(order.id, 100);
    const res = await cancel(order.id, { reason: "x", destination: "STORE_CREDIT" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no customer");
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("credits only what's left when part has already gone back", async () => {
    const { order, buyer } = await makeOrder();
    const payment = await pay(order.id, 300);
    await pay(order.id, 100, { isRefund: true, originalPaymentId: payment.id });
    const res = await cancel(order.id, { reason: "x", destination: "STORE_CREDIT" });
    expect(res.body.credited).toBe(200);
    expect(await getBalance(buyer!.id)).toBe(200);
  });

  it("gives money back only for a role that may", async () => {
    await makeStaff("lead", "MANAGER");
    await prisma.rolePermission.deleteMany({
      where: { role: { key: "MANAGER" }, permission: "payment.refund" },
    });
    await prisma.role.updateMany({ where: { key: "MANAGER" }, data: { grantsCustomized: true } });
    invalidateRoleGrantCache();
    const { order } = await makeOrder();
    await pay(order.id, 100);
    const res = await cancel(order.id, { reason: "x", destination: "ORIGINAL_PAYMENT" }, "lead");
    expect(res.status).toBe(403);
    expect(await statusOf(order.id)).toBe("ORDER");
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });

  it("can't credit the same money twice when two cancels arrive together", async () => {
    const { order, buyer } = await makeOrder();
    await pay(order.id, 300);
    const body = { reason: "x", destination: "STORE_CREDIT" };
    const results = await Promise.all([cancel(order.id, body), cancel(order.id, body)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await getBalance(buyer!.id)).toBe(300);
  });
});

describe("a card refund that fails", () => {
  it("leaves the order open, says why, and a retry refunds only what's left", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 200);
    await pay(order.id, 300, {
      paymentType: "Card",
      method: "CARD",
      processorType: "stripe",
      processorTxnId: "cs_test_1",
    });
    const refund = jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: connection reset"))
      .mockResolvedValueOnce({ refundId: "re_123" });

    const failed = await cancel(order.id, {
      reason: "x",
      destination: "ORIGINAL_PAYMENT",
    });

    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("still open");
    expect(failed.body.error).toContain("connection reset");
    expect(await statusOf(order.id)).toBe("ORDER");

    const retried = await cancel(order.id, {
      reason: "x",
      destination: "ORIGINAL_PAYMENT",
    });
    expect(retried.status).toBe(200);
    expect(await statusOf(order.id)).toBe("CANCELLED");
    // The failed one was tried again, and settled, rather than left waiting.
    expect(refund).toHaveBeenCalledTimes(2);
    const card = await prisma.payment.findFirstOrThrow({
      where: { salesOrderId: order.id, isRefund: true, method: "CARD" },
    });
    expect(card).toMatchObject({ status: "COMPLETED", processorTxnId: "re_123" });
    // The cash isn't refunded a second time.
    const cash = await prisma.payment.findMany({
      where: { salesOrderId: order.id, isRefund: true, method: "CASH", status: "COMPLETED" },
    });
    expect(cash.map((p) => Number(p.paymentAmount))).toEqual([200]);
  });
});

describe("what can't be cancelled", () => {
  it("a sale already cancelled", async () => {
    const { order } = await makeOrder();
    await cancel(order.id, { reason: "x" });
    const again = await cancel(order.id, { reason: "x" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("already cancelled");
    // The screen says so before anyone tries.
    const plan = await call(cancelRoute, "boss", {
      method: "GET",
      query: { id: String(order.id) },
    });
    expect(plan.body.problem).toContain("already cancelled");
  });

  it("a sale with a payment still going through", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 100, { status: "PENDING" });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("hasn't finished");
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("a sale with an imported payment that has no status, rather than skip that money", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 100, { status: null });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("import");
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("a sale already handed over", async () => {
    const { order } = await makeOrder();
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { status: "FULFILLED", deliveredAt: new Date() },
    });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(await statusOf(order.id)).toBe("FULFILLED");
  });

  it("a sale that's partly gone to the customer", async () => {
    const { order } = await makeOrder();
    await prisma.orderLineItem.update({
      where: { id: order.lineItems[0].id },
      data: { fulfilledQty: 1 },
    });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already gone to the customer");
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("an order that doesn't exist", async () => {
    expect((await cancel(999999, { reason: "x" })).status).toBe(404);
  });
});

describe("a special order's PO when the sale is cancelled", () => {
  it("cancels a draft the vendor never saw", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "DRAFT");
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(200);
    expect(res.body.tellVendors).toEqual([]);
    const after = await poOf(po.id);
    expect(after.status).toBe("CANCELLED");
    expect(Number(after.lineItems[0].orderedQuantity)).toBe(0);
  });

  it("cancels one that's been sent, and says to tell the vendor", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "SUBMITTED");
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(200);
    expect(res.body.tellVendors).toEqual([{ poNumber: po.poNumber, vendor: "Northfield" }]);
    expect((await poOf(po.id)).status).toBe("CANCELLED");
  });

  it("won't cancel over an acknowledged PO until someone decides, and changes nothing", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "CONFIRMED");
    await pay(order.id, 100);
    const res = await cancel(order.id, { reason: "x", destination: "ORIGINAL_PAYMENT" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("acknowledged by Northfield");
    expect(await statusOf(order.id)).toBe("ORDER");
    expect((await poOf(po.id)).status).toBe("CONFIRMED");
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });

  it("cancels the PO when the vendor agreed", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "CONFIRMED");
    const res = await cancel(order.id, {
      reason: "x",
      poDecisions: { [po.id]: "VENDOR_AGREED" },
    });
    expect(res.status).toBe(200);
    expect((await poOf(po.id)).status).toBe("CANCELLED");
    const history = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "PO_CANCELLED" },
    });
    expect(history).toMatchObject({
      newValue: po.poNumber,
      reason: "Northfield agreed to cancel it",
      changedBy: "boss@example.com",
    });
  });

  it("keeps the PO open as a stock order when the store keeps the piece", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "CONFIRMED");
    const res = await cancel(order.id, {
      reason: "x",
      poDecisions: { [po.id]: "KEEP_THE_PIECE" },
    });
    expect(res.status).toBe(200);
    expect(await statusOf(order.id)).toBe("CANCELLED");
    const after = await poOf(po.id);
    expect(after.status).toBe("CONFIRMED");
    expect(after.salesOrderId).toBeNull();
    expect(after.shipToLocationId).toBe(world.store.id);
    expect(after.lineItems[0].orderLineItemId).toBeNull();
    expect(Number(after.lineItems[0].orderedQuantity)).toBe(2);
    const history = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "PO_KEPT" },
    });
    expect(history.reason).toContain("sell off the floor");
  });

  it("short-closes what's left of one partly here, when the vendor agreed", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "RECEIVED_PARTIAL", { received: 1 });
    await cancel(order.id, { reason: "x", poDecisions: { [po.id]: "VENDOR_AGREED" } });
    const after = await poOf(po.id);
    expect(after.status).toBe("SHORT_CLOSED");
    expect(Number(after.lineItems[0].orderedQuantity)).toBe(1);
  });

  it("leaves a PO that's fully here alone, since the piece just goes back to stock", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "RECEIVED_FULL", { received: 2 });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(200);
    expect((await poOf(po.id)).status).toBe("RECEIVED_FULL");
  });

  it.each(["CONFIRMED", "RECEIVED_FULL"] as const)(
    "needs the right role when a PO is %s, and not for one that's still open",
    async (status) => {
      await makeStaff("lead", "MANAGER");
      await prisma.rolePermission.deleteMany({
        where: { role: { key: "MANAGER" }, permission: "sales.cancel-acknowledged" },
      });
      await prisma.role.updateMany({ where: { key: "MANAGER" }, data: { grantsCustomized: true } });
      invalidateRoleGrantCache();
      const { order } = await makeOrder();
      const po = await makePo(order, status);
      const res = await cancel(
        order.id,
        { reason: "x", poDecisions: { [po.id]: "KEEP_THE_PIECE" } },
        "lead",
      );
      expect(res.status).toBe(403);
      expect(await statusOf(order.id)).toBe("ORDER");

      const { order: other } = await makeOrder();
      await makePo(other, "SUBMITTED");
      expect((await cancel(other.id, { reason: "x" }, "lead")).status).toBe(200);
    },
  );

  it("refuses a decision it doesn't know", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "CONFIRMED");
    const res = await cancel(order.id, { reason: "x", poDecisions: { [po.id]: "SHRUG" } });
    expect(res.status).toBe(400);
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("tells the screen what each PO needs", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "CONFIRMED");
    const res = await call(cancelRoute, "boss", {
      method: "GET",
      query: { id: String(order.id) },
    });
    expect(res.body.canCallPo).toBe(true);
    expect(res.body.purchaseOrders).toEqual([
      expect.objectContaining({
        id: po.id,
        poNumber: po.poNumber,
        vendor: "Northfield",
        standing: "ACKNOWLEDGED",
        sentToVendor: true,
      }),
    ]);
  });
});

describe("everything else a cancel has to deal with", () => {
  it("cancels the lines, so nothing is owed and nobody can be asked to pay", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 300);
    await cancel(order.id, { reason: "Changed mind", destination: "ORIGINAL_PAYMENT" });
    const balance = await calculateOrderBalance(order.id);
    expect(balance.totalDue).toBe(0);
    expect(balance.balanceDue).toBe(0);
    const line = await prisma.orderLineItem.findUniqueOrThrow({
      where: { id: order.lineItems[0].id },
    });
    expect(line).toMatchObject({ lineItemStatus: "CANCELLED", cancelReason: "Changed mind" });
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.dispatchStatus).toBe("CANCELLED");
  });

  it("won't send a payment link for a cancelled order, with nothing owed on it", async () => {
    const { order } = await makeOrder();
    await pay(order.id, 300);
    await cancel(order.id, { reason: "x", destination: "ORIGINAL_PAYMENT" });
    const res = await call(paymentLinkRoute, "boss", { body: { orderId: order.id } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No balance due");
  });

  it("refuses a payment on a cancelled order", async () => {
    const { order } = await makeOrder();
    await cancel(order.id, { reason: "x" });
    await expect(recordPayment(order.id, { method: "CASH", amount: 10 } as never)).rejects.toThrow(
      "cancelled",
    );
  });

  it("won't hand over a cancelled order, even by a stop still on a run", async () => {
    const { order } = await makeOrder();
    await cancel(order.id, { reason: "x" });
    await expect(
      prisma.$transaction((tx) =>
        markHandedOver(tx, {
          salesOrderId: order.id,
          at: new Date(),
          method: "DELIVERY",
          actor: "x",
        } as never),
      ),
    ).rejects.toThrow("cancelled");
    expect(await statusOf(order.id)).toBe("CANCELLED");
  });

  it("refuses over a live invoice, since revenue and tax are booked from it", async () => {
    const { order } = await makeOrder();
    const invoice = await prisma.invoice.create({
      data: {
        salesOrderId: order.id,
        invoiceNo: "INV-9",
        invoiceDate: new Date(),
        taxAmount: 0,
        status: "ISSUED",
      } as never,
    });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("INV-9");

    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });
    expect((await cancel(order.id, { reason: "x" })).status).toBe(200);
  });

  it("refuses when a return is tied to it, and ignores a cancelled one", async () => {
    const { order, buyer } = await makeOrder();
    const ret = await prisma.return.create({
      data: {
        returnNumber: "RET-1",
        reason: "CUSTOMER_CHANGED_MIND",
        status: "INITIATED",
        salesOrderId: order.id,
        lineItemId: order.lineItems[0].id,
        customerId: buyer!.id,
        productId: world.product.id,
        quantity: 1,
      } as never,
    });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("RET-1");

    await prisma.return.update({ where: { id: ret.id }, data: { status: "CANCELLED" } });
    expect((await cancel(order.id, { reason: "x" })).status).toBe(200);
  });

  it("refuses while stock for it is moving between stores, and cancels a draft transfer", async () => {
    const other = await prisma.storeLocation.create({
      data: { name: "Harbor", code: "HB", type: "STORE" },
    });
    const { order } = await makeOrder();
    const transfer = await prisma.inventoryTransfer.create({
      data: {
        salesOrderId: order.id,
        productId: world.product.id,
        fromLocation: world.store.name,
        toLocation: other.name,
        requestedByUserId: "owner",
        quantity: 1,
        status: "IN_TRANSIT",
      },
    });
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("on its way");

    await prisma.inventoryTransfer.update({
      where: { id: transfer.id },
      data: { status: "DRAFT" },
    });
    expect((await cancel(order.id, { reason: "x" })).status).toBe(200);
    expect(
      (await prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status,
    ).toBe("CANCELLED");
  });

  async function schedule(orderId: number, stopStatus: "PENDING" | "EN_ROUTE") {
    const appointment = await prisma.serviceAppointment.create({
      data: {
        appointmentNumber: `APT-${orderId}`,
        salesOrderId: orderId,
        status: "SCHEDULED",
        type: "DELIVERY",
      },
    });
    const vehicle = await prisma.vehicle.create({ data: { name: `Truck ${orderId}` } as never });
    const run = await prisma.deliveryRun.create({
      data: { runNumber: `RUN-${orderId}`, runDate: new Date(), vehicleId: vehicle.id },
    });
    const stop = await prisma.deliveryStop.create({
      data: {
        deliveryRunId: run.id,
        serviceAppointmentId: appointment.id,
        stopOrder: 1,
        status: stopStatus,
      },
    });
    return { appointment, stop };
  }

  it("takes it off the schedule", async () => {
    const { order } = await makeOrder();
    const { appointment, stop } = await schedule(order.id, "PENDING");
    expect((await cancel(order.id, { reason: "x" })).status).toBe(200);
    expect(await prisma.deliveryStop.count({ where: { id: stop.id } })).toBe(0);
    expect(
      (await prisma.serviceAppointment.findUniqueOrThrow({ where: { id: appointment.id } })).status,
    ).toBe("CANCELLED");
  });

  it("refuses when it's on the truck", async () => {
    const { order } = await makeOrder();
    await schedule(order.id, "EN_ROUTE");
    const res = await cancel(order.id, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("out for delivery");
  });

  it("puts consignment pieces back on the floor, and notes credit if the vendor was paid", async () => {
    const { order } = await makeOrder();
    const vendorId = world.product.vendorId;
    const make = (barcode: string, status: "SOLD" | "PAID") =>
      prisma.consignmentItem.create({
        data: {
          barcode,
          status,
          vendorId,
          cost: 100,
          salesOrderId: order.id,
          saleDate: new Date(),
        },
      });
    const sold = await make("M1-01", "SOLD");
    const paid = await make("M1-02", "PAID");
    expect((await cancel(order.id, { reason: "x" })).status).toBe(200);
    expect(
      await prisma.consignmentItem.findUniqueOrThrow({ where: { id: sold.id } }),
    ).toMatchObject({
      status: "ON_FLOOR",
      salesOrderId: null,
      creditOwed: false,
    });
    expect(
      await prisma.consignmentItem.findUniqueOrThrow({ where: { id: paid.id } }),
    ).toMatchObject({
      status: "ON_FLOOR",
      creditOwed: true,
    });
  });

  it("closes the oversold exceptions it left", async () => {
    const { order } = await makeOrder();
    const exception = await prisma.inventoryException.create({
      data: {
        salesOrderId: order.id,
        productId: world.product.id,
        storeLocationId: world.store.id,
        requested: 1,
        allocated: 0,
        shortfall: 1,
      },
    });
    await cancel(order.id, { reason: "x" });
    const after = await prisma.inventoryException.findUniqueOrThrow({
      where: { id: exception.id },
    });
    expect(after.resolvedBy).toBe("boss@example.com");
    expect(after.resolvedAt).not.toBeNull();
  });

  it("warns about a locked commission payout, but doesn't stop", async () => {
    const boss = await prisma.staffMember.findFirstOrThrow({ where: { userId: "boss" } });
    const { order } = await makeOrder();
    const now = new Date();
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { salesPersonId: boss.id, orderDate: now },
    });
    await prisma.commissionPayout.create({
      data: {
        staffMemberId: boss.id,
        periodStart: new Date(now.getTime() - 86400000),
        periodEnd: new Date(now.getTime() + 86400000),
        periodSalesAmount: 0,
        ytdSalesAtStart: 0,
        ytdSalesAtEnd: 0,
        tierBreakdown: [],
        commissionAmount: 0,
        tierDefinitionSnapshot: [],
        lockedAt: now,
      },
    });
    const plan = await call(cancelRoute, "boss", {
      method: "GET",
      query: { id: String(order.id) },
    });
    expect(plan.body.notices.join(" ")).toContain("locked commission payout");
    expect(plan.body.problem).toBeNull();
    expect((await cancel(order.id, { reason: "x" })).status).toBe(200);
  });
});

describe("raising a special order's PO", () => {
  async function specialOrder(status: "ORDER" | "QUOTE" = "ORDER") {
    const made = await makeOrder({ status });
    await prisma.orderLineItem.updateMany({
      where: { salesOrderId: made.order.id },
      data: { source: "SPECIAL" as never, cost: 400 },
    });
    return made;
  }
  const posFor = (id: number) =>
    prisma.purchaseOrder.findMany({ where: { salesOrderId: id }, include: { lineItems: true } });

  it("raises a draft when the first payment comes in", async () => {
    const { order } = await specialOrder("QUOTE");
    await pay(order.id, 100);
    await onPaymentReceived(order.id);
    const pos = await posFor(order.id);
    expect(pos).toHaveLength(1);
    expect(pos[0].status).toBe("DRAFT");
    expect(pos[0].lineItems[0].orderLineItemId).toBe(order.lineItems[0].id);
  });

  it("raises one when the store lets a sale go ahead with nothing paid", async () => {
    await call(settingsRoute, "owner", {
      method: "PUT",
      body: { allowSaleWithoutPayment: true },
    });
    invalidateAppSettingsCache();
    const { order } = await specialOrder("QUOTE");
    const res = await call(orderRoute, "boss", {
      method: "PUT",
      query: { id: String(order.id) },
      body: { status: "ORDER" },
    });
    expect(res.status).toBe(200);
    expect(await posFor(order.id)).toHaveLength(1);
  });

  it("raises none for floor stock, a cancelled line, or a zero line", async () => {
    const { order } = await makeOrder();
    await prisma.orderLineItem.updateMany({
      where: { salesOrderId: order.id },
      data: { source: "FLOOR" as never },
    });
    await raiseSpecialOrderPos(order.id);
    expect(await posFor(order.id)).toHaveLength(0);

    await prisma.orderLineItem.updateMany({
      where: { salesOrderId: order.id },
      data: { source: "SPECIAL" as never, lineItemStatus: "CANCELLED" },
    });
    await raiseSpecialOrderPos(order.id);
    expect(await posFor(order.id)).toHaveLength(0);

    await prisma.orderLineItem.updateMany({
      where: { salesOrderId: order.id },
      data: { lineItemStatus: "ACTIVE", orderedQuantity: 0 },
    });
    await raiseSpecialOrderPos(order.id);
    expect(await posFor(order.id)).toHaveLength(0);
  });

  it("won't let raising a PO by hand be how a quote goes ahead unpaid", async () => {
    const { order } = await specialOrder("QUOTE");
    const res = await call(createPoRoute, "boss", { query: { id: String(order.id) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("takes a payment");
    expect(await statusOf(order.id)).toBe("QUOTE");
    expect(await posFor(order.id)).toHaveLength(0);
  });

  it("won't raise a PO by hand for a cancelled sale", async () => {
    const { order } = await specialOrder();
    await cancel(order.id, { reason: "x" });
    const res = await call(createPoRoute, "boss", { query: { id: String(order.id) } });
    expect(res.status).toBe(400);
    expect(await posFor(order.id)).toHaveLength(0);
  });

  it("raises one for a line added later, and doesn't repeat the first", async () => {
    const { order } = await specialOrder();
    await raiseSpecialOrderPos(order.id);
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 2,
        productId: world.product.id,
        productName: "Sofa",
        orderedQuantity: 1,
        netPrice: 100,
        cost: 40,
        vatRate: 0,
        vatAmount: 0,
        source: "SPECIAL" as never,
      },
    });
    await raiseSpecialOrderPos(order.id);
    const pos = await posFor(order.id);
    expect(pos).toHaveLength(2);
    expect(pos.flatMap((po) => po.lineItems)).toHaveLength(2);
    await raiseSpecialOrderPos(order.id);
    expect(await posFor(order.id)).toHaveLength(2);
  });

  it("leaves an order alone when an imported PO's lines don't say what they cover", async () => {
    const { order } = await specialOrder();
    await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-OLD",
        vendorId: world.product.vendorId,
        salesOrderId: order.id,
        status: "CONFIRMED",
        lineItems: {
          create: [
            {
              productId: world.product.id,
              partNo: "S-1",
              productName: "Sofa",
              orderedQuantity: 1,
              unitCost: 400,
            },
          ],
        },
      } as never,
    });
    await raiseSpecialOrderPos(order.id);
    expect(await posFor(order.id)).toHaveLength(1);
  });
});

describe("changing a line on a special order", () => {
  const change = (orderId: number, lineId: number, body: object, who = "boss") =>
    call(lineRoute, who, {
      method: "PUT",
      query: { id: String(orderId), lineItemId: String(lineId) },
      body,
    });

  it.each(["DRAFT", "SUBMITTED"] as const)(
    "changes the quantity while the PO is %s, and the PO follows",
    async (status) => {
      const { order } = await makeOrder();
      const po = await makePo(order, status);
      const res = await change(order.id, order.lineItems[0].id, {
        action: "update",
        quantity: 3,
      });
      expect(res.status).toBe(200);
      expect(Number((await poOf(po.id)).lineItems[0].orderedQuantity)).toBe(3);
    },
  );

  it.each(["CONFIRMED", "RECEIVED_PARTIAL", "RECEIVED_FULL"] as const)(
    "won't change the quantity or product once the PO is %s",
    async (status) => {
      const { order } = await makeOrder();
      const po = await makePo(order, status);
      const lineId = order.lineItems[0].id;
      const qty = await change(order.id, lineId, { action: "update", quantity: 3 });
      expect(qty.status).toBe(409);
      expect(qty.body.error).toContain("acknowledged");
      const swap = await change(order.id, lineId, {
        action: "replace",
        replacement: { productName: "Chair", unitPrice: 100 },
      });
      expect(swap.status).toBe(409);
      expect(Number((await poOf(po.id)).lineItems[0].orderedQuantity)).toBe(2);
    },
  );

  it("still changes the price once it's acknowledged: the vendor's order is the same", async () => {
    const { order } = await makeOrder();
    await makePo(order, "CONFIRMED");
    const res = await change(order.id, order.lineItems[0].id, {
      action: "update",
      unitPrice: 900,
    });
    expect(res.status).toBe(200);
  });

  it("takes a cancelled line off a PO that isn't acknowledged, and closes it if that's all", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "SUBMITTED");
    const res = await change(order.id, order.lineItems[0].id, { action: "cancel", reason: "x" });
    expect(res.status).toBe(200);
    expect((await poOf(po.id)).status).toBe("CANCELLED");
  });

  it("asks what happens when the line's PO is acknowledged", async () => {
    const { order } = await makeOrder();
    await makePo(order, "CONFIRMED");
    const res = await change(order.id, order.lineItems[0].id, { action: "cancel", reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("acknowledged by Northfield");
  });

  it("leaves the PO alone when the store keeps the piece, so it arrives free", async () => {
    const { order } = await makeOrder();
    const po = await makePo(order, "CONFIRMED");
    const res = await change(order.id, order.lineItems[0].id, {
      action: "cancel",
      reason: "x",
      poDecision: "KEEP_THE_PIECE",
    });
    expect(res.status).toBe(200);
    expect((await poOf(po.id)).status).toBe("CONFIRMED");
    const arrives = await prisma.$transaction((tx) =>
      receiptOrderId(tx, { salesOrderId: order.id }, { orderLineItemId: order.lineItems[0].id }),
    );
    expect(arrives).toBeNull();
  });

  it("needs the right role for that call", async () => {
    await makeStaff("lead", "MANAGER");
    await prisma.rolePermission.deleteMany({
      where: { role: { key: "MANAGER" }, permission: "sales.cancel-acknowledged" },
    });
    await prisma.role.updateMany({ where: { key: "MANAGER" }, data: { grantsCustomized: true } });
    invalidateRoleGrantCache();
    const { order } = await makeOrder();
    await makePo(order, "CONFIRMED");
    const res = await change(
      order.id,
      order.lineItems[0].id,
      { action: "cancel", reason: "x", poDecision: "VENDOR_AGREED" },
      "lead",
    );
    expect(res.status).toBe(403);
  });

  it("won't change anything on a cancelled sale", async () => {
    const { order } = await makeOrder();
    await cancel(order.id, { reason: "x" });
    const res = await change(order.id, order.lineItems[0].id, { action: "update", unitPrice: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("cancelled");
  });

  it("won't let a sale with a PO at the vendor go back to a quote", async () => {
    const { order } = await makeOrder();
    await makePo(order, "SUBMITTED");
    const res = await call(orderRoute, "boss", {
      method: "PUT",
      query: { id: String(order.id) },
      body: { status: "QUOTE" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("has gone to Northfield");
  });
});

describe("a line change that leaves the customer overpaid", () => {
  const change = (orderId: number, lineId: number, body: object, who = "boss") =>
    call(lineRoute, who, {
      method: "PUT",
      query: { id: String(orderId), lineItemId: String(lineId) },
      body,
    });

  /** Two lines, $600 and $400, with what's been paid. */
  async function twoLines(paid: number[]) {
    const made = await makeOrder({ total: 600 });
    const second = await prisma.orderLineItem.create({
      data: {
        salesOrderId: made.order.id,
        lineNumber: 2,
        productId: world.product.id,
        productName: "Chair",
        orderedQuantity: 2,
        netPrice: 400,
        cost: 100,
        vatRate: 0,
        vatAmount: 0,
      },
    });
    for (const amount of paid) await pay(made.order.id, amount);
    return { ...made, first: made.order.lineItems[0], second };
  }

  it("asks where the rest goes, naming how much, and changes nothing", async () => {
    const { order, second } = await twoLines([1000]);
    const res = await change(order.id, second.id, { action: "cancel", reason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.overpaid.excess).toBe(400);
    const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: second.id } });
    expect(line.lineItemStatus).toBe("ACTIVE");
  });

  it("asks nothing when the deposit doesn't cover what's left", async () => {
    const { order, second } = await twoLines([300]);
    const res = await change(order.id, second.id, { action: "cancel", reason: "x" });
    expect(res.status).toBe(200);
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });

  it("gives back only what's over, not the line's whole price", async () => {
    const { order, second } = await twoLines([700]);
    const res = await change(order.id, second.id, {
      action: "cancel",
      reason: "x",
      destination: "ORIGINAL_PAYMENT",
    });
    expect(res.status).toBe(200);
    const refunds = await prisma.payment.findMany({ where: { isRefund: true } });
    expect(refunds.map((r) => Number(r.paymentAmount))).toEqual([100]);
    const balance = await calculateOrderBalance(order.id);
    expect(balance.balanceDue).toBe(0);
    const history = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "REFUND_ISSUED" },
    });
    expect(history).toMatchObject({
      lineItemId: second.id,
      newValue: "100",
      reason: "x",
      changedBy: "boss@example.com",
    });
  });

  it("takes it from the newest payment first", async () => {
    const { order, second } = await twoLines([]);
    const older = await pay(order.id, 800);
    const newer = await pay(order.id, 200, { paymentType: "Check", method: "CHECK" });
    await change(order.id, second.id, {
      action: "cancel",
      reason: "x",
      destination: "ORIGINAL_PAYMENT",
    });
    const refunds = await prisma.payment.findMany({
      where: { isRefund: true },
      orderBy: { id: "asc" },
    });
    expect(refunds.map((r) => [r.originalPaymentId, Number(r.paymentAmount)])).toEqual([
      [newer.id, 200],
      [older.id, 200],
    ]);
  });

  it("leaves it on the account, with the line, in one go", async () => {
    const { order, buyer, second } = await twoLines([1000]);
    const res = await change(order.id, second.id, {
      action: "cancel",
      reason: "Changed mind",
      destination: "STORE_CREDIT",
    });
    expect(res.status).toBe(200);
    expect(await getBalance(buyer!.id)).toBe(400);
    const history = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "CREDIT_ISSUED" },
    });
    expect(history).toMatchObject({
      newValue: "400",
      reason: "Changed mind",
      changedBy: "boss@example.com",
    });
  });

  it("can't leave credit with no customer", async () => {
    const made = await makeOrder({ customer: false, total: 500 });
    await pay(made.order.id, 500);
    const res = await change(made.order.id, made.order.lineItems[0].id, {
      action: "cancel",
      reason: "x",
      destination: "STORE_CREDIT",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no customer");
  });

  it("needs a role that may give money back", async () => {
    await makeStaff("lead", "MANAGER");
    await prisma.rolePermission.deleteMany({
      where: { role: { key: "MANAGER" }, permission: "payment.refund" },
    });
    await prisma.role.updateMany({ where: { key: "MANAGER" }, data: { grantsCustomized: true } });
    invalidateRoleGrantCache();
    const { order, second } = await twoLines([1000]);
    const res = await change(
      order.id,
      second.id,
      { action: "cancel", reason: "x", destination: "ORIGINAL_PAYMENT" },
      "lead",
    );
    expect(res.status).toBe(403);
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });

  it("applies to a price going down too", async () => {
    const { order, second } = await twoLines([1000]);
    const asked = await change(order.id, second.id, { action: "update", unitPrice: 100 });
    expect(asked.status).toBe(409);
    expect(asked.body.overpaid.excess).toBe(200);
    const res = await change(order.id, second.id, {
      action: "update",
      unitPrice: 100,
      destination: "ORIGINAL_PAYMENT",
      discountApproval: undefined,
    });
    expect(res.status).toBe(200);
    expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
  });

  it("credits a price going down, in the same change", async () => {
    const { order, buyer, second } = await twoLines([1000]);
    const res = await change(order.id, second.id, {
      action: "update",
      unitPrice: 100,
      destination: "STORE_CREDIT",
    });
    expect(res.status).toBe(200);
    expect(await getBalance(buyer!.id)).toBe(200);
  });

  it("counts the tax a lower price takes off", async () => {
    const { order, second } = await twoLines([]);
    await prisma.orderLineItem.update({
      where: { id: second.id },
      data: { vatAmount: 28, vatRate: 0.07 },
    });
    await pay(order.id, 1028);
    const asked = await change(order.id, second.id, { action: "update", unitPrice: 100 });
    expect(asked.body.overpaid.excess).toBe(214);
  });

  it("applies to a quantity going down too", async () => {
    const { order, second } = await twoLines([1000]);
    const asked = await change(order.id, second.id, { action: "update", quantity: 1 });
    expect(asked.status).toBe(409);
    expect(asked.body.overpaid.excess).toBe(200);
  });

  it("applies to a cheaper replacement too", async () => {
    const { order, second } = await twoLines([1000]);
    const asked = await change(order.id, second.id, {
      action: "replace",
      replacement: { productName: "Stool", unitPrice: 50, quantity: 2 },
    });
    expect(asked.status).toBe(409);
    expect(asked.body.overpaid.excess).toBe(300);
  });

  // The same change sent twice (a double click, a retried request): the second used to work out
  // the same overpayment as the first before either moved money, and settle it again. The
  // customer's row is held so both are under way, past their reads, before either commits.
  describe("sent twice", () => {
    const holdBuyer = (customerId: number) =>
      holdRows(Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`);

    async function twice(
      orderId: number,
      lineId: number,
      customerId: number,
      body: object,
      otherBody: object = body,
    ) {
      const hold = await holdBuyer(customerId);
      const both = Promise.all([change(orderId, lineId, body), change(orderId, lineId, otherBody)]);
      await waitForLockWaits(2);
      await hold.release();
      return (await both).map((r) => r.status).sort();
    }

    it("credits a cancelled line's money once", async () => {
      const { order, buyer, second } = await twoLines([1000]);
      const statuses = await twice(order.id, second.id, buyer!.id, {
        action: "cancel",
        reason: "x",
        destination: "STORE_CREDIT",
      });
      expect(statuses).toEqual([200, 409]);
      expect(await getBalance(buyer!.id)).toBe(400);
    });

    it("refunds a cancelled line's money once", async () => {
      const { order, buyer, second } = await twoLines([1000]);
      const statuses = await twice(order.id, second.id, buyer!.id, {
        action: "cancel",
        reason: "x",
        destination: "ORIGINAL_PAYMENT",
      });
      expect(statuses).toEqual([200, 409]);
      const refunds = await prisma.payment.findMany({ where: { isRefund: true } });
      expect(refunds.map((r) => Number(r.paymentAmount))).toEqual([400]);
      expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
    });

    it("adds one replacement, and credits it once", async () => {
      const { order, buyer, second } = await twoLines([1000]);
      const statuses = await twice(order.id, second.id, buyer!.id, {
        action: "replace",
        replacement: { productName: "Stool", unitPrice: 50, quantity: 2 },
        destination: "STORE_CREDIT",
      });
      expect(statuses).toEqual([200, 409]);
      expect(await getBalance(buyer!.id)).toBe(300);
      expect(
        await prisma.orderLineItem.count({
          where: { salesOrderId: order.id, productName: "Stool" },
        }),
      ).toBe(1);
    });

    it("credits a lower price once", async () => {
      const { order, buyer, second } = await twoLines([1000]);
      const statuses = await twice(order.id, second.id, buyer!.id, {
        action: "update",
        unitPrice: 100,
        destination: "STORE_CREDIT",
      });
      // The second finds the line's price changed since it read it, and stops.
      expect(statuses).toEqual([200, 409]);
      expect(await getBalance(buyer!.id)).toBe(200);
      expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
    });

    // A price rise from another tab (no money back) commits while a quantity cut is past its reads
    // and waiting to refund. The cut's refund used to go out on the old line, and then the cut was
    // refused: money back for a change that never happened.
    it("refunds nothing for a change whose line moved before its refund went out", async () => {
      const { order, second } = await twoLines([1000]);
      const hold = await holdRows(
        Prisma.sql`SELECT id FROM "SalesOrder" WHERE id = ${order.id} FOR UPDATE`,
      );
      const rise = change(order.id, second.id, { action: "update", unitPrice: 300 });
      await waitForLockWaits(1);
      const cut = change(order.id, second.id, {
        action: "update",
        quantity: 1,
        destination: "ORIGINAL_PAYMENT",
      });
      await waitForLockWaits(2);
      await hold.release();
      const [rose, cutRes] = await Promise.all([rise, cut]);

      expect([rose.status, cutRes.status]).toEqual([200, 409]);
      expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
      const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: second.id } });
      expect([Number(line.orderedQuantity), Number(line.netPrice)]).toEqual([2, 600]);
    });

    // Two different changes from two tabs: the quantity from 2 to 1, and the unit price from 200
    // to 150, each worked out from the line as it was. The second used to pass the status check,
    // write a total worked out from the old line (one chair at $300), and settle nothing.
    it("refuses a change worked out from a line another change has just moved", async () => {
      const { order, buyer, second } = await twoLines([1000]);
      const statuses = await twice(
        order.id,
        second.id,
        buyer!.id,
        { action: "update", quantity: 1, destination: "STORE_CREDIT" },
        { action: "update", unitPrice: 150, destination: "STORE_CREDIT" },
      );
      expect(statuses).toEqual([200, 409]);
      const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: second.id } });
      const won =
        Number(line.orderedQuantity) === 1
          ? { netPrice: 200, credit: 200 }
          : { netPrice: 300, credit: 100 };
      expect(Number(line.netPrice)).toBe(won.netPrice);
      expect(await getBalance(buyer!.id)).toBe(won.credit);
      expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
    });
  });

  it("credits a cheaper replacement, in the same change", async () => {
    const { order, buyer, second } = await twoLines([1000]);
    const res = await change(order.id, second.id, {
      action: "replace",
      replacement: { productName: "Stool", unitPrice: 50, quantity: 2 },
      destination: "STORE_CREDIT",
    });
    expect(res.status).toBe(200);
    expect(await getBalance(buyer!.id)).toBe(300);
  });

  it("asks nothing when the price goes up", async () => {
    const { order, second } = await twoLines([1000]);
    const res = await change(order.id, second.id, { action: "update", unitPrice: 300 });
    expect(res.status).toBe(200);
  });

  it("counts tax", async () => {
    const { order, second } = await twoLines([]);
    await prisma.orderLineItem.update({
      where: { id: second.id },
      data: { vatAmount: 28, vatRate: 0.07 },
    });
    await pay(order.id, 1028);
    const asked = await change(order.id, second.id, { action: "cancel", reason: "x" });
    expect(asked.body.overpaid.excess).toBe(428);
  });

  it("leaves the line as it was when a card refund fails, and a retry finishes", async () => {
    const { order, second } = await twoLines([]);
    await pay(order.id, 1000, {
      paymentType: "Card",
      method: "CARD",
      processorType: "stripe",
      processorTxnId: "cs_test_1",
    });
    const refund = jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: connection reset"))
      .mockResolvedValueOnce({ refundId: "re_123" });
    const body = { action: "cancel", reason: "x", destination: "ORIGINAL_PAYMENT" };

    const failed = await change(order.id, second.id, body);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("hasn't changed");
    const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: second.id } });
    expect(line.lineItemStatus).toBe("ACTIVE");

    const retried = await change(order.id, second.id, body);
    expect(retried.status).toBe(200);
    expect(refund).toHaveBeenCalledTimes(2);
    const refunds = await prisma.payment.findMany({ where: { isRefund: true } });
    expect(refunds.map((r) => [Number(r.paymentAmount), r.status])).toEqual([[400, "COMPLETED"]]);
  });

  describe("when the money can't be settled yet", () => {
    const stays = async (lineId: number) => {
      const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(line.lineItemStatus).toBe("ACTIVE");
      expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
    };
    const body = { action: "cancel", reason: "x", destination: "ORIGINAL_PAYMENT" };
    const makeInvoice = (salesOrderId: number, status = "ISSUED") =>
      prisma.invoice.create({
        data: {
          salesOrderId,
          invoiceNo: "INV-9",
          invoiceDate: new Date(),
          taxAmount: 0,
          status,
        } as never,
      });

    it("a live invoice has to be voided first", async () => {
      const { order, second } = await twoLines([1000]);
      await makeInvoice(order.id);
      const res = await change(order.id, second.id, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Void it first");
      await stays(second.id);
    });

    it("a voided invoice doesn't stop it", async () => {
      const { order, second } = await twoLines([1000]);
      await makeInvoice(order.id, "VOID");
      const res = await change(order.id, second.id, body);
      expect(res.status).toBe(200);
    });

    it("a payment still going through has to finish", async () => {
      const { order, second } = await twoLines([1000]);
      await pay(order.id, 50, { status: "PENDING" });
      const res = await change(order.id, second.id, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("hasn't finished");
      await stays(second.id);
    });

    it("an imported payment with no status counts as paid, and is refused", async () => {
      const { order, second } = await twoLines([]);
      await pay(order.id, 1000, { status: null });
      const res = await change(order.id, second.id, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("no status");
      await stays(second.id);
    });

    it("a return tied to the sale stops it", async () => {
      const { order, buyer, second } = await twoLines([1000]);
      await prisma.return.create({
        data: {
          returnNumber: "RET-1",
          reason: "CUSTOMER_CHANGED_MIND",
          status: "INITIATED",
          salesOrderId: order.id,
          lineItemId: second.id,
          customerId: buyer!.id,
          productId: world.product.id,
          quantity: 1,
        } as never,
      });
      const res = await change(order.id, second.id, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("is tied to this order");
      await stays(second.id);
    });

    it("none of it stands in the way when no money moves", async () => {
      const { order, second } = await twoLines([300]);
      await makeInvoice(order.id);
      const res = await change(order.id, second.id, { action: "cancel", reason: "x" });
      expect(res.status).toBe(200);
    });
  });

  describe("a line that's gone to the customer", () => {
    const refused = (res: Awaited<ReturnType<typeof change>>) => {
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already gone to the customer");
    };

    it("can't be cancelled or replaced, only returned", async () => {
      const { order, second } = await twoLines([1000]);
      await prisma.orderLineItem.update({ where: { id: second.id }, data: { fulfilledQty: 1 } });
      refused(await change(order.id, second.id, { action: "cancel", reason: "x" }));
      refused(
        await change(order.id, second.id, {
          action: "replace",
          replacement: { productName: "Stool" },
        }),
      );
      expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
    });

    it("can lose only what hasn't gone", async () => {
      const { order, second } = await twoLines([1000]);
      await prisma.orderLineItem.update({
        where: { id: second.id },
        data: { orderedQuantity: 3, netPrice: 600, fulfilledQty: 2 },
      });
      refused(await change(order.id, second.id, { action: "update", quantity: 1 }));
      const res = await change(order.id, second.id, { action: "update", quantity: 2 });
      expect(res.status).toBe(200);
    });

    it("counts a sale handed over whole, even with no quantity recorded", async () => {
      const { order, second } = await twoLines([1000]);
      await prisma.salesOrder.update({
        where: { id: order.id },
        data: { status: "FULFILLED", deliveredAt: new Date() },
      });
      refused(await change(order.id, second.id, { action: "cancel", reason: "x" }));
    });
  });

  it("says what's wrong when a refund is too old to retry", async () => {
    const { order, second } = await twoLines([]);
    await pay(order.id, 1000, {
      paymentType: "Card",
      method: "CARD",
      processorType: "stripe",
      processorTxnId: "cs_test_1",
    });
    jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: connection reset"));
    const body = { action: "cancel", reason: "x", destination: "ORIGINAL_PAYMENT" };
    await change(order.id, second.id, body);
    await prisma.$executeRaw`UPDATE "Payment" SET created = '2020-01-01' WHERE "isRefund" = true`;

    const res = await change(order.id, second.id, body);
    expect(res.status).toBe(400);
    const line = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: second.id } });
    expect(line.lineItemStatus).toBe("ACTIVE");
  });

  it("still asks when all that's left is a refund that didn't finish", async () => {
    const { order, second } = await twoLines([]);
    await pay(order.id, 1000, {
      paymentType: "Card",
      method: "CARD",
      processorType: "stripe",
      processorTxnId: "cs_test_1",
    });
    jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: connection reset"));
    await change(order.id, second.id, {
      action: "cancel",
      reason: "x",
      destination: "ORIGINAL_PAYMENT",
    });

    const asked = await change(order.id, second.id, { action: "cancel", reason: "x" });
    expect(asked.status).toBe(409);
    expect(asked.body.overpaid).toMatchObject({ excess: 400, toSettle: 0, payments: [] });
  });

  it("finishes a refund first, and leaves only the rest as credit", async () => {
    const { order, buyer, second } = await twoLines([]);
    await pay(order.id, 1000, {
      paymentType: "Card",
      method: "CARD",
      processorType: "stripe",
      processorTxnId: "cs_test_1",
    });
    const refund = jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: connection reset"))
      .mockResolvedValueOnce({ refundId: "re_123" });
    const down = await change(order.id, second.id, {
      action: "update",
      unitPrice: 150,
      destination: "ORIGINAL_PAYMENT",
    });
    expect(down.status).toBe(502);

    const res = await change(order.id, second.id, {
      action: "cancel",
      reason: "x",
      destination: "STORE_CREDIT",
    });
    expect(res.status).toBe(200);
    expect(refund).toHaveBeenCalledTimes(2);
    expect(await getBalance(buyer!.id)).toBe(300);
    expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
  });

  it("asks nothing of a raise, even on a sale already overpaid", async () => {
    const { order, second } = await twoLines([1100]);
    const res = await change(order.id, second.id, { action: "update", unitPrice: 210 });
    expect(res.status).toBe(200);
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });
});

describe("the status buttons", () => {
  const setStatus = (id: number, status: string) =>
    call(orderRoute, "boss", { method: "PUT", query: { id: String(id) }, body: { status } });

  it("can't cancel, so the money can't be skipped", async () => {
    const { order } = await makeOrder();
    const res = await setStatus(order.id, "CANCELLED");
    expect(res.status).toBe(409);
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("can't reopen a cancelled sale", async () => {
    const { order } = await makeOrder();
    await cancel(order.id, { reason: "x" });
    const res = await setStatus(order.id, "ORDER");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("copy it");
    expect(await statusOf(order.id)).toBe("CANCELLED");
  });
});

describe("deleting", () => {
  const remove = (id: number, who = "boss") =>
    call(orderRoute, who, { method: "DELETE", query: { id: String(id) } });

  it("deletes a quote with no money on it, and gives back what it held", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    await stockAt({
      productId: world.product.id,
      storeLocationId: world.store.id,
      quantity: 1,
      salesOrderId: order.id,
    });
    expect((await remove(order.id)).status).toBe(204);
    expect(await prisma.salesOrder.count({ where: { id: order.id } })).toBe(0);
    const free = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: world.product.id, salesOrderId: null },
    });
    expect(Number(free.quantity)).toBe(1);
  });

  it.each(["ORDER", "FULFILLED", "CANCELLED"] as const)(
    "won't delete a sale that's %s, and says to cancel",
    async (status) => {
      const { order } = await makeOrder();
      await prisma.salesOrder.update({ where: { id: order.id }, data: { status } });
      const res = await remove(order.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Only a quote");
      expect(await prisma.salesOrder.count({ where: { id: order.id } })).toBe(1);
    },
  );

  it("won't delete a quote with a payment on it, whatever state the payment's in", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    await pay(order.id, 100, { status: "PENDING" });
    const res = await remove(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("payment on it");
    expect(await prisma.payment.count({ where: { salesOrderId: order.id } })).toBe(1);
  });

  it("won't delete a quote that's been invoiced", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    await prisma.invoice.create({
      data: {
        salesOrderId: order.id,
        invoiceNo: "INV-1",
        invoiceDate: new Date(),
        taxAmount: 0,
      } as never,
    });
    const res = await remove(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("invoiced");
  });

  it("is still only for a manager", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    expect((await remove(order.id, "till")).status).toBe(403);
    expect(await prisma.salesOrder.count({ where: { id: order.id } })).toBe(1);
  });

  it("answers plainly for one that isn't there", async () => {
    expect((await remove(999999)).status).toBe(404);
  });
});

describe("a sale going ahead with no payment", () => {
  const setStatus = (id: number, status: string) =>
    call(orderRoute, "boss", { method: "PUT", query: { id: String(id) }, body: { status } });

  const allow = async (allowed: boolean) => {
    const res = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { allowSaleWithoutPayment: allowed },
    });
    expect(res.status).toBe(200);
    invalidateAppSettingsCache();
  };

  it("is refused by default, and the quote stays a quote", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    const res = await setStatus(order.id, "ORDER");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("takes a payment");
    expect(await statusOf(order.id)).toBe("QUOTE");
  });

  it("is refused for handing a quote over too, by either route", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    expect((await setStatus(order.id, "FULFILLED")).status).toBe(409);
    const res = await call(dispatchRoute, "boss", {
      method: "PUT",
      query: { id: String(order.id) },
      body: { dispatchStatus: "FULFILLED" },
    });
    expect(res.status).toBe(409);
    expect(await statusOf(order.id)).toBe("QUOTE");
  });

  it("goes ahead once the store allows it", async () => {
    await allow(true);
    const { order } = await makeOrder({ status: "QUOTE" });
    expect((await setStatus(order.id, "ORDER")).status).toBe(200);
    expect(await statusOf(order.id)).toBe("ORDER");
  });

  it("is refused again once the store turns it back off", async () => {
    await allow(true);
    await allow(false);
    const { order } = await makeOrder({ status: "QUOTE" });
    expect((await setStatus(order.id, "ORDER")).status).toBe(409);
  });

  it("goes ahead with a deposit taken, whatever the setting", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    await pay(order.id, 1);
    expect((await setStatus(order.id, "ORDER")).status).toBe(200);
  });

  it("doesn't count a payment still going through as paid", async () => {
    const { order } = await makeOrder({ status: "QUOTE" });
    await pay(order.id, 100, { status: "PENDING" });
    expect((await setStatus(order.id, "ORDER")).status).toBe(409);
  });

  it("goes ahead when there's nothing to pay", async () => {
    const { order } = await makeOrder({ status: "QUOTE", total: 0 });
    expect((await setStatus(order.id, "ORDER")).status).toBe(200);
  });

  it("refuses a setting that isn't true or false", async () => {
    const res = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { allowSaleWithoutPayment: "yes" },
    });
    expect(res.status).toBe(400);
  });

  it("is recorded when the store changes it", async () => {
    await allow(true);
    const entry = await prisma.auditEntry.findFirstOrThrow({
      where: { event: "SETTINGS_SAVED" },
    });
    expect(entry.summary).toContain("allowSaleWithoutPayment");
  });
});

// The gate that reads it is covered in giftCardSaleBooks.integration.test.ts.
describe("refunding unused gift cards (Settings)", () => {
  it("is off by default, saves, is recorded, and refuses a value that isn't true or false", async () => {
    invalidateAppSettingsCache();
    expect((await getAppSettings()).giftCardsRefundable).toBe(false);

    const bad = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { giftCardsRefundable: "yes" },
    });
    expect(bad.status).toBe(400);

    const res = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { giftCardsRefundable: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.giftCardsRefundable).toBe(true);
    const entry = await prisma.auditEntry.findFirstOrThrow({
      where: { event: "SETTINGS_SAVED" },
    });
    expect(entry.summary).toContain("giftCardsRefundable");
  });
});
