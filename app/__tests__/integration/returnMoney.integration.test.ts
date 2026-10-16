// /app/__tests__/integration/returnMoney.integration.test.ts
//
// Paying out a native return against real Postgres (ledger plan PR 2b): the
// return books as its own RETURNED order, refunds go back to the original
// payment or onto store credit, a restocking fee is kept, and the day's
// journal reverses the sale exactly -- no Over/Short plug.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { generateSalesJournal } from "@/lib/journalEntry";
import { businessDayKey } from "@/lib/reports/businessDay";
import {
  calculateOrderBalance,
  recordPayment,
  RefundProcessorError,
  retryProcessorRefund,
} from "@/lib/paymentService";
import { refundReturn } from "@/lib/returns/refundReturn";
import { ReturnMoneyError } from "@/lib/returns/returnMoney";
import { loadReturnDetail } from "@/lib/returns/returnDetail";
import { stripeProvider } from "@/lib/payments/stripeProvider";
import { handler as refundHandler } from "@/pages/api/returns/[id]/refund";
import { handler as statusHandler } from "@/pages/api/returns/[id]/status";
import { handler as orderHandler } from "@/pages/api/sales/orders/[id]";
import { handler as lineHandler } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";

const TZ = "America/New_York";
const todayKey = () => businessDayKey(new Date(), TZ);
const marker = (key: string) => new Date(`${key}T00:00:00Z`);
/** Noon in the business zone two days before today: an earlier journal than today's. */
const earlier = () => new Date(marker(todayKey()).getTime() - 2 * 86_400_000 + 16 * 3_600_000);

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

const req = (method: string, id: number, body: unknown = {}) =>
  ({ method, query: { id: String(id) }, body, headers: {} }) as unknown as NextApiRequest;

const session = { user: { email: "desk@example.test" } } as unknown as Session;

async function world(opts: { feeMapped?: boolean; paid?: number; processor?: boolean } = {}) {
  const gl = async (code: string, name: string, accountType: string) =>
    prisma.gLAccount.create({ data: { code, name, accountType } });
  const cash = await gl("1-1006", "Cash", "ASSET");
  const deposit = await gl("2-2200", "Customer Deposits", "LIABILITY");
  const ar = await gl("1-1100", "Accounts Receivable", "ASSET");
  const sales = await gl("4-4080", "Furniture Sales", "REVENUE");
  const cogs = await gl("5-5280", "Furniture COGS", "EXPENSE");
  const inventory = await gl("1-1380", "Furniture Inventory", "ASSET");
  const shrinkage = await gl("5-5010", "Shrinkage", "EXPENSE");
  const tax = await gl("2-2120", "Sales Tax Payable", "LIABILITY");
  const overShort = await gl("5-5900", "Over/Short", "EXPENSE");
  const fee = await gl("4-4950", "Restocking Fees", "REVENUE");
  const credit = await gl("2-2128", "Store Credit Liability", "LIABILITY");
  const map = (section: string, label: string, glAccountId: number | null) =>
    prisma.systemGLMapping.create({ data: { section, label, glAccountId } });
  await map("POS_PAYMENTS", "Cash", cash.id);
  await map("POS_PAYMENTS", "Card", cash.id);
  await map("POS_PAYMENTS", "On Account", deposit.id);
  await map("POS_PAYMENTS", "Store Credit", credit.id);
  await map("AR_TRANSACTIONS", "Accounts Receivable", ar.id);
  await map("POS_TRANSACTIONS", "Sales Tax", tax.id);
  await map("POS_TRANSACTIONS", "Over/Short", overShort.id);
  await map("POS_TRANSACTIONS", "Restocking Fee", opts.feeMapped === false ? null : fee.id);

  const group = await prisma.accountGroup.create({
    data: {
      name: "Furniture",
      salesAccountId: sales.id,
      cogsAccountId: cogs.id,
      inventoryAccountId: inventory.id,
      shrinkageAccountId: shrinkage.id,
    },
  });
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, accountGroupId: group.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Camelback Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });

  const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
  const soldAt = earlier();
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-100",
      status: "FULFILLED",
      orderDate: soldAt,
      customerId: customer.id,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: product.id,
            productName: "Camelback Sofa",
            orderedQuantity: 1,
            netPrice: 1000,
            vatAmount: 63.5,
            cost: 400,
          },
        ],
      },
      invoices: { create: [{ invoiceNo: "INV-100", invoiceDate: soldAt, taxAmount: 63.5 }] },
    },
    include: { lineItems: true },
  });
  const payment = await prisma.payment.create({
    data: {
      salesOrderId: order.id,
      paymentDate: soldAt,
      paymentType: opts.processor ? "Card" : "Cash",
      method: opts.processor ? "CARD" : "CASH",
      paymentAmount: opts.paid ?? 1063.5,
      status: "COMPLETED",
      customerId: customer.id,
      ...(opts.processor ? { processorType: "stripe", processorTxnId: "cs_test_1" } : {}),
    },
  });
  const ret = await prisma.return.create({
    data: {
      returnNumber: "RET-TEST-001",
      reason: "CUSTOMER_CHANGED_MIND",
      status: "RECEIVED",
      salesOrderId: order.id,
      lineItemId: order.lineItems[0].id,
      customerId: customer.id,
      productId: product.id,
      quantity: 1,
    },
  });
  return {
    gl: { cash, ar, sales, cogs, inventory, shrinkage, tax, overShort, fee, credit },
    customer,
    order,
    payment,
    ret,
    product,
  };
}

/** Today's journal as {glAccountId: debit - credit}. */
async function todaysJournal() {
  const result = await generateSalesJournal(marker(todayKey()), "test");
  const net = new Map<number, number>();
  for (const l of result.journalEntry?.lines ?? []) {
    net.set(
      l.glAccount.id,
      Math.round(((net.get(l.glAccount.id) ?? 0) + l.debit - l.credit) * 100) / 100,
    );
  }
  return { net, warnings: result.warnings };
}

describe("paying out a native return (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a cash refund books the return as its own order, and the day's journal reverses the sale with no plug", async () => {
    const w = await world();
    const refund = await refundReturn(w.ret.id, {
      destination: "ORIGINAL_PAYMENT",
      paymentId: w.payment.id,
      amount: 913.5,
      restockingFee: { percent: 15 },
    });
    expect(refund).toMatchObject({ status: "COMPLETED", isRefund: true, returnId: w.ret.id });

    const booked = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    const returnOrder = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: booked.returnOrderId! },
      include: { lineItems: true, invoices: true },
    });
    expect(returnOrder.status).toBe("RETURNED");
    expect(returnOrder.invoices).toHaveLength(1);
    expect(refund!.salesOrderId).toBe(returnOrder.id);
    // The original order is untouched and still paid in full; the return's own order is settled.
    expect((await calculateOrderBalance(w.order.id)).balanceDue).toBe(0);
    expect((await calculateOrderBalance(returnOrder.id)).balanceDue).toBe(0);

    const { net, warnings } = await todaysJournal();
    expect(net.get(w.gl.sales.id)).toBe(1000);
    expect(net.get(w.gl.tax.id)).toBe(63.5);
    expect(net.get(w.gl.inventory.id)).toBe(400);
    expect(net.get(w.gl.cogs.id)).toBe(-400);
    expect(net.get(w.gl.fee.id)).toBe(-150);
    expect(net.get(w.gl.cash.id)).toBe(-913.5);
    expect(net.get(w.gl.ar.id) ?? 0).toBe(0);
    expect(net.get(w.gl.overShort.id)).toBeUndefined();
    expect(warnings.filter((m) => m.includes("Over/Short"))).toEqual([]);
  });

  it("a written-off piece books to shrinkage instead of inventory", async () => {
    const w = await world();
    await prisma.return.update({ where: { id: w.ret.id }, data: { writtenOffAt: new Date() } });
    await refundReturn(w.ret.id, {
      destination: "ORIGINAL_PAYMENT",
      paymentId: w.payment.id,
      amount: 1063.5,
    });
    const { net } = await todaysJournal();
    expect(net.get(w.gl.shrinkage.id)).toBe(400);
    expect(net.get(w.gl.inventory.id)).toBeUndefined();
    expect(net.get(w.gl.overShort.id)).toBeUndefined();
  });

  it("store credit credits the liability and the customer's balance, and never touches the card", async () => {
    const w = await world({ processor: true });
    const refundSpy = jest.spyOn(stripeProvider, "refund");
    await refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 1063.5 });
    expect(refundSpy).not.toHaveBeenCalled();

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: w.customer.id } });
    expect(Number(customer.creditBalance)).toBe(1063.5);
    const txn = await prisma.customerCreditTransaction.findFirstOrThrow({
      where: { customerId: w.customer.id },
    });
    expect(txn).toMatchObject({ type: "REFUND_CREDIT" });
    expect(txn.paymentId).not.toBeNull();
    // The card payment is still whole: nothing went back to it.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: w.payment.id } })).status).toBe(
      "COMPLETED",
    );

    const { net } = await todaysJournal();
    expect(net.get(w.gl.credit.id)).toBe(-1063.5);
    expect(net.get(w.gl.overShort.id)).toBeUndefined();
  });

  it("store credit is spent on the customer's own order, and only there", async () => {
    const w = await world();
    await refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 500 });
    const next = await prisma.salesOrder.create({
      data: {
        orderno: "SO-101",
        status: "ORDER",
        orderDate: new Date(),
        customerId: w.customer.id,
      },
    });
    const spend = await recordPayment(next.id, { method: "STORE_CREDIT", amount: 300 });
    const usage = await prisma.customerCreditTransaction.findFirstOrThrow({
      where: { customerId: w.customer.id, type: "USAGE" },
    });
    expect(usage.paymentId).toBe(spend.id);

    const stranger = await prisma.customer.create({ data: { firstName: "B", lastName: "C" } });
    const theirs = await prisma.salesOrder.create({
      data: { orderno: "SO-102", status: "ORDER", orderDate: new Date(), customerId: stranger.id },
    });
    await expect(
      recordPayment(theirs.id, { method: "STORE_CREDIT", amount: 50, customerId: w.customer.id }),
    ).rejects.toThrow("same customer's order");
    const walkIn = await prisma.salesOrder.create({
      data: { orderno: "SO-103", status: "ORDER", orderDate: new Date() },
    });
    await expect(
      recordPayment(walkIn.id, { method: "STORE_CREDIT", amount: 50, customerId: w.customer.id }),
    ).rejects.toThrow("with a customer");

    // Two spends racing for the last $200: exactly one wins.
    const results = await Promise.allSettled([
      recordPayment(next.id, { method: "STORE_CREDIT", amount: 150 }),
      recordPayment(next.id, { method: "STORE_CREDIT", amount: 150 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: w.customer.id } });
    expect(Number(customer.creditBalance)).toBe(50);
  });

  it("the fee needs its account, and is fixed once the first refund books it", async () => {
    const unmapped = await world({ feeMapped: false });
    await expect(
      refundReturn(unmapped.ret.id, {
        destination: "ORIGINAL_PAYMENT",
        paymentId: unmapped.payment.id,
        amount: 100,
        restockingFee: { amount: 50 },
      }),
    ).rejects.toThrow('map "Restocking Fee"');
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: unmapped.ret.id } })).returnOrderId,
    ).toBeNull();
    // A zero fee never needs it.
    await refundReturn(unmapped.ret.id, {
      destination: "ORIGINAL_PAYMENT",
      paymentId: unmapped.payment.id,
      amount: 100,
    });

    await resetTestDb();
    const w = await world();
    await refundReturn(w.ret.id, {
      destination: "ORIGINAL_PAYMENT",
      paymentId: w.payment.id,
      amount: 100,
      restockingFee: { amount: 150 },
    });
    await expect(
      refundReturn(w.ret.id, {
        destination: "ORIGINAL_PAYMENT",
        paymentId: w.payment.id,
        amount: 100,
        restockingFee: { amount: 0 },
      }),
    ).rejects.toThrow("cannot change");
  });

  it("refunds sum up to the cap; a FAILED refund paid nothing, so it does not count", async () => {
    const w = await world();
    const pay = (amount: number) =>
      refundReturn(w.ret.id, { destination: "ORIGINAL_PAYMENT", paymentId: w.payment.id, amount });
    await pay(500);
    const booked = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    await prisma.payment.create({
      data: {
        salesOrderId: booked.returnOrderId,
        paymentDate: new Date(),
        paymentType: "Cash",
        paymentAmount: 500,
        status: "FAILED",
        isRefund: true,
        returnId: w.ret.id,
      },
    });
    await refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 400 });
    await expect(pay(200)).rejects.toThrow("Only $163.50");
    await pay(163.5);
    await expect(pay(0.01)).rejects.toThrow(ReturnMoneyError);
  });

  it("a processor error leaves the refund PENDING and counted; a retry settles it with the same key", async () => {
    const w = await world({ processor: true });
    const refund = jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: connection reset"))
      .mockResolvedValueOnce({ refundId: "re_123" });

    await expect(
      refundReturn(w.ret.id, {
        destination: "ORIGINAL_PAYMENT",
        paymentId: w.payment.id,
        amount: 1063.5,
      }),
    ).rejects.toThrow(RefundProcessorError);
    const pending = await prisma.payment.findFirstOrThrow({
      where: { returnId: w.ret.id, isRefund: true },
    });
    expect(pending.status).toBe("PENDING");
    expect(await prisma.customerLedgerEntry.count({ where: { type: "REFUND_ISSUED" } })).toBe(0);
    // Counted by the cap: nothing more can be refunded while it waits.
    await expect(
      refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 1 }),
    ).rejects.toThrow(ReturnMoneyError);

    const settled = await retryProcessorRefund(pending.id);
    expect(settled).toMatchObject({ status: "COMPLETED", processorTxnId: "re_123" });
    const keys = refund.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([`holt-refund-${pending.id}`, `holt-refund-${pending.id}`]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: w.payment.id } })).status).toBe(
      "REFUNDED",
    );
    expect(await prisma.customerLedgerEntry.count({ where: { type: "REFUND_ISSUED" } })).toBe(1);
  });

  it("what the original order still owes is paid first from the return", async () => {
    const w = await world({ paid: 500 });
    // Worth 1063.50; the order still owes 563.50; 500 is left to give back.
    await expect(
      refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 600 }),
    ).rejects.toThrow("Only $500.00");
    await refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 500 });
    expect((await calculateOrderBalance(w.order.id)).balanceDue).toBe(0);
    const booked = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    expect((await calculateOrderBalance(booked.returnOrderId!)).balanceDue).toBe(0);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: w.customer.id } });
    expect(Number(customer.creditBalance)).toBe(500);
  });

  it("refuses a cancelled return, another order's payment, and cancelling a booked return", async () => {
    const w = await world();
    const other = await prisma.salesOrder.create({
      data: {
        orderno: "SO-200",
        status: "ORDER",
        orderDate: new Date(),
        customerId: w.customer.id,
      },
    });
    const otherPayment = await prisma.payment.create({
      data: {
        salesOrderId: other.id,
        paymentDate: new Date(),
        paymentType: "Cash",
        method: "CASH",
        paymentAmount: 100,
        status: "COMPLETED",
      },
    });
    const wrong = makeRes();
    await refundHandler(
      req("POST", w.ret.id, {
        destination: "ORIGINAL_PAYMENT",
        paymentId: otherPayment.id,
        amount: 10,
      }),
      wrong,
      session,
    );
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body.error).toContain("not a payment on this return's order");

    const ok = makeRes();
    await refundHandler(
      req("POST", w.ret.id, { destination: "STORE_CREDIT", amount: 10 }),
      ok,
      session,
    );
    expect(ok.statusCode).toBe(201);

    const cancel = makeRes();
    await statusHandler(req("PUT", w.ret.id, { status: "CANCELLED" }), cancel, session);
    expect(cancel.statusCode).toBe(409);

    await prisma.return.update({ where: { id: w.ret.id }, data: { status: "CANCELLED" } });
    const cancelled = makeRes();
    await refundHandler(
      req("POST", w.ret.id, { destination: "STORE_CREDIT", amount: 10 }),
      cancelled,
      session,
    );
    expect(cancelled.statusCode).toBe(409);
  });

  it("a return's own order changes only through the return", async () => {
    const w = await world();
    await refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 100 });
    const { returnOrderId } = await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } });
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: returnOrderId! },
    });

    const status = makeRes();
    await orderHandler(
      {
        method: "PUT",
        query: { id: String(returnOrderId) },
        body: { status: "CANCELLED" },
        headers: {},
      } as unknown as NextApiRequest,
      status,
      session,
    );
    expect(status.statusCode).toBe(409);
    expect(status.body.error).toContain("RET-TEST-001");

    const edit = makeRes();
    await lineHandler(
      {
        method: "PUT",
        query: { id: String(returnOrderId), lineItemId: String(line.id) },
        body: { quantity: 5 },
        headers: {},
      } as unknown as NextApiRequest,
      edit,
      session,
    );
    expect(edit.statusCode).toBe(409);
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: returnOrderId! } });
    expect(after.status).toBe("RETURNED");

    // The original order is still an ordinary order.
    const original = makeRes();
    await orderHandler(
      {
        method: "PUT",
        query: { id: String(w.order.id) },
        body: { orderNotes: "ok" },
        headers: {},
      } as unknown as NextApiRequest,
      original,
      session,
    );
    expect(original.statusCode).toBe(200);
  });

  it("a return refunded in full before it was booked is not booked again", async () => {
    const w = await world();
    // The old refund route paid returns out against the original order.
    await prisma.payment.create({
      data: {
        salesOrderId: w.order.id,
        paymentDate: new Date(),
        paymentType: "Cash",
        method: "CASH",
        paymentAmount: 1063.5,
        status: "COMPLETED",
        isRefund: true,
        originalPaymentId: w.payment.id,
        returnId: w.ret.id,
      },
    });
    await expect(
      refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 1 }),
    ).rejects.toThrow("Nothing is left to refund");
    expect(
      (await prisma.return.findUniqueOrThrow({ where: { id: w.ret.id } })).returnOrderId,
    ).toBeNull();
    expect(await prisma.salesOrder.count({ where: { status: "RETURNED" } })).toBe(0);
  });

  it("the detail sends the screen's contract", async () => {
    const w = await world();
    await refundReturn(w.ret.id, { destination: "STORE_CREDIT", amount: 63.5 });
    const detail = await loadReturnDetail(prisma, w.ret.id);
    expect(detail).toMatchObject({
      returnNumber: "RET-TEST-001",
      salesOrder: { id: w.order.id, orderno: "SO-100" },
      customer: { id: w.customer.id, name: "Ada Lane", creditBalance: 63.5 },
      money: {
        valued: true,
        returnedNet: 1000,
        returnedTax: 63.5,
        restockingFee: 0,
        feeBooked: true,
        refundedTotal: 63.5,
        originalOwes: 0,
        refundable: 1000,
      },
    });
    expect(new Date(detail!.created).toISOString()).toBe(detail!.created);
    expect(detail!.money.refunds).toEqual([
      expect.objectContaining({ destination: "STORE_CREDIT", amount: 63.5, status: "COMPLETED" }),
    ]);
  });
});
