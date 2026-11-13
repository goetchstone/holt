// /app/__tests__/integration/paymentRaces.integration.test.ts
//
// Owner: every money change is one transaction with its ledger row, and nothing appears,
// vanishes or posts twice. The ledger audit of 2026-11-11 found the payment code reading a
// row's state and then writing as if it still held: two completions of one checkout both
// posted it, a void or an expiry landed on a payment that had just been paid, a refund the
// processor was paying out could be voided, an invoice took two payments for one balance, and
// a webhook's ledger entry committed while its invoice application didn't (and a retry never
// came back for it). Each test here puts the two requests into the race on purpose: it holds
// a row the first one needs (__tests__/helpers/locks.ts), waits until Postgres has both
// queued, then lets go. Real database and routes; only the processor's side (its signature
// check and event parsing, its refund call), the credential lookup and the alert channel are
// stood in for.

import { Readable } from "node:stream";
import { Prisma } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import type { PaymentCompletion } from "@/lib/payments";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { holdRows, waitForLockWaits } from "../helpers/locks";

let mockCompletion: PaymentCompletion | null = null;

jest.mock("@/lib/payments", () => ({
  ...jest.requireActual("@/lib/payments"),
  getPaymentProvider: (id: string) => ({
    id,
    displayName: id === "stripe" ? "Stripe" : "Square",
    capabilities: { hostedCheckout: true, terminal: false, refunds: true },
    verifyWebhook: async () => ({ providerId: id, type: "test", raw: {} }),
    extractCompletion: async () => mockCompletion,
    extractExpiration: async () => null,
  }),
}));
jest.mock("@/lib/integrationCredentials", () => ({
  resolveCredential: async () => "whsec_test",
}));
jest.mock("@/lib/opsAlert", () => ({
  reportOpsAlert: jest.fn(async () => undefined),
}));

import { reportOpsAlert } from "@/lib/opsAlert";
import stripeWebhook from "@/pages/api/stripe/webhook";
import squareWebhook from "@/pages/api/square/webhook";
import { stripeProvider } from "@/lib/payments/stripeProvider";
import {
  completePayment,
  expirePendingPayment,
  processRefund,
  RefundProcessorError,
  voidPendingPayment,
  VoidError,
} from "@/lib/paymentService";
import {
  createDraftInvoice,
  deleteDraftInvoice,
  issueInvoice,
  recordInvoicePayment,
  voidInvoice,
} from "@/lib/billing/invoiceService";

async function deliver(handler: unknown, url: string) {
  const req = Object.assign(Readable.from([Buffer.from("{}")]), {
    method: "POST",
    headers: {},
    url,
  });
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

const holdCustomer = (customerId: number) =>
  holdRows(Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`);

/** The signed amounts of a type of ledger entry on a customer, oldest first. */
async function ledger(customerId: number, type: string): Promise<number[]> {
  const rows = await prisma.customerLedgerEntry.findMany({
    where: { customerId, type: type as never },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => Number(r.amount));
}

async function openAr(customerId: number): Promise<number> {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  return Number(c.openArBalance);
}

let txnSeq = 0;

/** An order for $500 with a hosted checkout open on it for `amount`. */
async function openCheckout(amount = 400) {
  txnSeq += 1;
  const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Race" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: `SO-RACE-${txnSeq}`,
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      lineItems: {
        create: [
          { lineNumber: 1, netPrice: 500, cost: 0, orderedQuantity: 1, lineItemStatus: "ACTIVE" },
        ],
      },
    },
  });
  const payment = await prisma.payment.create({
    data: {
      salesOrderId: order.id,
      customerId: customer.id,
      paymentDate: new Date(),
      paymentType: "Card",
      paymentAmount: amount,
      status: "PENDING",
      method: "CARD",
      processorType: "STRIPE",
      processorTxnId: `cs_race_${txnSeq}`,
    },
  });
  return { customer, order, payment };
}

beforeEach(async () => {
  await resetTestDb();
  mockCompletion = null;
  jest.mocked(reportOpsAlert).mockClear();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a checkout completing", () => {
  it("posts once when two completions of it arrive together", async () => {
    const { customer, payment } = await openCheckout(400);
    const hold = await holdCustomer(customer.id);

    const both = Promise.allSettled([completePayment(payment.id), completePayment(payment.id)]);
    await waitForLockWaits(2);
    await hold.release();
    const results = await both;

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await ledger(customer.id, "PAYMENT")).toEqual([-400]);
    expect(await openAr(customer.id)).toBe(-400);
  });

  it("posts once when Square sends its two completion events for one payment together", async () => {
    const { customer, order, payment } = await openCheckout(400);
    mockCompletion = {
      providerTxnId: payment.processorTxnId!,
      metadata: { orderId: String(order.id) },
    };
    const hold = await holdCustomer(customer.id);

    const both = Promise.all([
      deliver(squareWebhook, "/api/square/webhook"),
      deliver(squareWebhook, "/api/square/webhook"),
    ]);
    await waitForLockWaits(2);
    await hold.release();
    const responses = await both;

    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await ledger(customer.id, "PAYMENT")).toEqual([-400]);
    // The second found it paid: a repeat, not money Holt lost track of.
    expect(reportOpsAlert).not.toHaveBeenCalled();
  });

  it("writes nothing for a checkout voided before its completion arrived", async () => {
    const { customer, payment } = await openCheckout(400);
    await voidPendingPayment(payment.id, { voidedBy: "boss@example.com" });

    expect(await completePayment(payment.id)).toBeNull();

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe("VOIDED");
    expect(await ledger(customer.id, "PAYMENT")).toEqual([]);
  });
});

describe("ending a checkout while it completes", () => {
  it("refuses a void that lands while the payment completes, and the payment stays paid", async () => {
    const { customer, payment } = await openCheckout(400);
    const hold = await holdCustomer(customer.id);

    const completing = completePayment(payment.id);
    await waitForLockWaits(1);
    const voiding = voidPendingPayment(payment.id, { voidedBy: "boss@example.com" });
    const settled = Promise.allSettled([completing, voiding]);
    await waitForLockWaits(2);
    await hold.release();
    const [completed, voided] = await settled;

    expect(completed.status).toBe("fulfilled");
    expect(voided.status).toBe("rejected");
    expect((voided as PromiseRejectedResult).reason).toBeInstanceOf(VoidError);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe("COMPLETED");
    expect(await ledger(customer.id, "PAYMENT")).toEqual([-400]);
    expect(await prisma.orderChangeLog.count({ where: { changeType: "PAYMENT_VOIDED" } })).toBe(0);
  });

  it("leaves a payment paid when the stale sweep's expiry lands while it completes", async () => {
    const { customer, payment } = await openCheckout(400);
    const hold = await holdCustomer(customer.id);

    const completing = completePayment(payment.id);
    await waitForLockWaits(1);
    const expiring = expirePendingPayment(payment.id);
    const settled = Promise.allSettled([completing, expiring]);
    await waitForLockWaits(2);
    await hold.release();
    const [completed, expired] = await settled;

    expect(completed.status).toBe("fulfilled");
    expect(expired).toEqual({ status: "fulfilled", value: null });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe("COMPLETED");
    expect(await ledger(customer.id, "PAYMENT")).toEqual([-400]);
  });
});

describe("a refund waiting on the card processor", () => {
  async function paidByCard(amount: number) {
    const { customer, order, payment } = await openCheckout(amount);
    await completePayment(payment.id);
    return { customer, order, payment };
  }

  it("can't be voided while the processor has it, and settles with its ledger entry", async () => {
    const { customer, payment } = await paidByCard(400);
    let answer!: (r: { refundId: string }) => void;
    const processorAnswers = new Promise<{ refundId: string }>((resolve) => (answer = resolve));
    let called!: () => void;
    const processorHasIt = new Promise<void>((resolve) => (called = resolve));
    jest.spyOn(stripeProvider, "refund").mockImplementation(async () => {
      called();
      return processorAnswers;
    });

    const refunding = processRefund(payment.id, { amount: 150, reason: "Scratched" });
    await processorHasIt;
    const pending = await prisma.payment.findFirstOrThrow({ where: { isRefund: true } });
    expect(pending.status).toBe("PENDING");

    const voiding = voidPendingPayment(pending.id, { voidedBy: "boss@example.com" });
    await expect(voiding).rejects.toThrow(VoidError);
    await expect(voiding).rejects.toThrow("with the card processor");

    answer({ refundId: "re_race_1" });
    const refund = await refunding;

    expect(refund).toMatchObject({ id: pending.id, status: "COMPLETED" });
    expect(await ledger(customer.id, "REFUND_ISSUED")).toEqual([150]);
  });

  it("can be voided once the processor has said no, as its message says", async () => {
    const { customer, payment } = await paidByCard(400);
    jest
      .spyOn(stripeProvider, "refund")
      .mockRejectedValueOnce(new Error("Stripe refund failed: card closed"));

    await expect(processRefund(payment.id, { amount: 150 })).rejects.toThrow(RefundProcessorError);
    const pending = await prisma.payment.findFirstOrThrow({ where: { isRefund: true } });

    const voided = await voidPendingPayment(pending.id, { voidedBy: "boss@example.com" });

    expect(voided.status).toBe("VOIDED");
    expect(await ledger(customer.id, "REFUND_ISSUED")).toEqual([]);
  });
});

async function seedOrgAndGl({ card = true }: { card?: boolean } = {}) {
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  const gl = (code: string, name: string, accountType: string) =>
    prisma.gLAccount.create({ data: { code, name, accountType } });
  const ar = await gl("1-1100", "Accounts Receivable", "ASSET");
  const revenue = await gl("4-4000", "Service Revenue", "REVENUE");
  const cash = await gl("1-1006", "Cash", "ASSET");
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: ar.id },
      { section: "AR_TRANSACTIONS", label: "Invoice Sales", glAccountId: revenue.id },
      { section: "POS_PAYMENTS", label: "Check", glAccountId: cash.id },
      ...(card ? [{ section: "POS_PAYMENTS", label: "Card", glAccountId: cash.id }] : []),
    ],
  });
  return { cash };
}

async function issuedInvoice(total: number) {
  const customer = await prisma.customer.create({ data: { firstName: "Bea", lastName: "Bill" } });
  const { id } = await createDraftInvoice({
    customerId: customer.id,
    lines: [{ description: "Work", quantity: 1, unitPrice: total }],
  });
  await issueInvoice(id);
  return { customer, invoiceId: id };
}

/** A card checkout bound to the invoice, as createInvoicePaymentLink writes it. */
async function invoiceCheckout(customerId: number, invoiceId: number, amount: number) {
  return prisma.payment.create({
    data: {
      paymentDate: new Date(),
      paymentType: "Card",
      paymentAmount: amount,
      status: "PENDING",
      method: "CARD",
      customerId,
      invoiceId,
      processorType: "STRIPE",
      processorTxnId: `cs_inv_${invoiceId}_${amount}`,
    },
  });
}

const applied = async (invoiceId: number) =>
  (await prisma.paymentApplication.findMany({ where: { invoiceId } })).map((a) =>
    Number(a.amountApplied),
  );

describe("an invoice paid by card through the webhook", () => {
  it("posts the payment with its application and journal or not at all, and a retry posts it once", async () => {
    const { cash } = await seedOrgAndGl({ card: false });
    const { customer, invoiceId } = await issuedInvoice(500);
    const payment = await invoiceCheckout(customer.id, invoiceId, 500);
    mockCompletion = {
      providerTxnId: payment.processorTxnId!,
      metadata: { invoiceId: String(invoiceId) },
    };

    // No GL mapping for "Card": the journal can't post, so nothing does.
    const failed = await deliver(stripeWebhook, "/api/stripe/webhook");

    expect(failed.statusCode).toBe(500);
    expect(reportOpsAlert).toHaveBeenCalledTimes(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "PENDING",
    );
    expect(await ledger(customer.id, "PAYMENT")).toEqual([]);
    expect(await applied(invoiceId)).toEqual([]);

    // Mapped, the processor's retry finds it still open and posts all of it.
    await prisma.systemGLMapping.create({
      data: { section: "POS_PAYMENTS", label: "Card", glAccountId: cash.id },
    });
    const retried = await deliver(stripeWebhook, "/api/stripe/webhook");
    const again = await deliver(stripeWebhook, "/api/stripe/webhook");

    expect([retried.statusCode, again.statusCode]).toEqual([200, 200]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "COMPLETED",
    );
    expect(await ledger(customer.id, "PAYMENT")).toEqual([-500]);
    expect(await applied(invoiceId)).toEqual([500]);
    expect(await prisma.journalEntry.count({ where: { journalType: "AR_PAYMENT" } })).toBe(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      "PAID",
    );
  });
});

describe("an invoice's row, locked by everything that changes it", () => {
  it("takes one of two payments of the whole balance arriving together, and refuses the other", async () => {
    await seedOrgAndGl();
    const { customer, invoiceId } = await issuedInvoice(1000);
    const hold = await holdCustomer(customer.id);

    const both = Promise.allSettled([
      recordInvoicePayment(invoiceId, { amount: 1000, method: "CHECK" }),
      recordInvoicePayment(invoiceId, { amount: 1000, method: "CHECK" }),
    ]);
    await waitForLockWaits(2);
    await hold.release();
    const results = await both;

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await applied(invoiceId)).toEqual([1000]);
    expect(await ledger(customer.id, "PAYMENT")).toEqual([-1000]);
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(1);
  });

  it("never applies more than the invoice when a card payment and a recorded one land together", async () => {
    await seedOrgAndGl();
    const { customer, invoiceId } = await issuedInvoice(500);
    const card = await invoiceCheckout(customer.id, invoiceId, 500);
    const hold = await holdCustomer(customer.id);

    const both = Promise.allSettled([
      completePayment(card.id, undefined, { metadataInvoiceId: invoiceId }),
      recordInvoicePayment(invoiceId, { amount: 500, method: "CHECK" }),
    ]);
    await waitForLockWaits(2);
    await hold.release();
    await both;

    expect(await applied(invoiceId)).toEqual([500]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      "PAID",
    );
  });

  it("lets a void or a payment through when they land together, never both", async () => {
    await seedOrgAndGl();
    const { customer, invoiceId } = await issuedInvoice(800);
    const hold = await holdCustomer(customer.id);

    const both = Promise.allSettled([
      recordInvoicePayment(invoiceId, { amount: 800, method: "CHECK" }),
      voidInvoice(invoiceId, "boss@example.com"),
    ]);
    await waitForLockWaits(2);
    await hold.release();
    const [paid, voided] = await both;

    expect([paid.status, voided.status].sort()).toEqual(["fulfilled", "rejected"]);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const reversal = await prisma.journalEntry.count({
      where: { journalNumber: `ARV-${invoice.invoiceNo}` },
    });
    if (invoice.status === "VOID") {
      expect(await applied(invoiceId)).toEqual([]);
      expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0);
      expect(await openAr(customer.id)).toBe(0);
    } else {
      expect(invoice.status).toBe("PAID");
      expect(reversal).toBe(0);
      expect(await openAr(customer.id)).toBe(0);
    }
  });

  it("never deletes an invoice an issue landed on while the delete was under way", async () => {
    await seedOrgAndGl();
    const customer = await prisma.customer.create({ data: { firstName: "Cy", lastName: "Draft" } });
    const { id } = await createDraftInvoice({
      customerId: customer.id,
      lines: [{ description: "Work", quantity: 1, unitPrice: 300 }],
    });
    const hold = await holdRows(
      Prisma.sql`SELECT id FROM "InvoiceLineItem" WHERE "invoiceId" = ${id} FOR UPDATE`,
    );

    const deleting = deleteDraftInvoice(id);
    await waitForLockWaits(1);
    const issuing = issueInvoice(id, "boss@example.com");
    const both = Promise.allSettled([deleting, issuing]);
    await waitForLockWaits(2, 1_000);
    await hold.release();
    await both;

    const invoice = await prisma.invoice.findUnique({ where: { id } });
    const sales = await ledger(customer.id, "SALE");
    const journals = await prisma.journalEntry.count({ where: { journalType: "AR_SALE" } });
    if (invoice) {
      expect(invoice.status).toBe("ISSUED");
      expect(sales).toEqual([300]);
      expect(journals).toBe(1);
    } else {
      expect(sales).toEqual([]);
      expect(journals).toBe(0);
    }
  });
});
