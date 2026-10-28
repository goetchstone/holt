// /app/__tests__/integration/untrackedCheckoutPaid.integration.test.ts
//
// A checkout Holt stopped tracking can still be paid. A `force` replacement
// or an operator's void marks our PENDING row VOIDED, and the stale sweep
// marks a Square link FAILED, but none of them closes the session at the
// processor. When the customer pays it anyway, both webhooks used to find no
// PENDING row and answer 200 with nothing said: money at the processor,
// nothing in the books. Now they raise an ops alert naming the row
// (paymentService.reportUntrackedCheckoutPaid), and stay silent for a retry
// of a completed payment or a session Holt never knew.
//
// Real DB for the rows; the provider's signature check and event parsing,
// the credential lookup and the alert channel are stubbed, since none of
// them decides whether the alert fires.

import { Readable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import type { PaymentCompletion } from "@/lib/payments";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

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

function mockRes() {
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
  return res;
}

async function deliver(handler: unknown, url: string) {
  const req = Object.assign(Readable.from([Buffer.from("{}")]), {
    method: "POST",
    headers: {},
    url,
  });
  const res = mockRes();
  await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

async function seedOrder() {
  const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Byrne" } });
  return prisma.salesOrder.create({
    data: {
      orderno: "Q-UNTRACKED-1",
      status: "ORDER",
      orderDate: new Date("2026-10-01"),
      customerId: customer.id,
    },
  });
}

async function seedPayment(
  data: { salesOrderId?: number; invoiceId?: number; customerId?: number | null },
  status: "VOIDED" | "FAILED" | "COMPLETED",
  processorTxnId: string,
) {
  return prisma.payment.create({
    data: {
      ...data,
      paymentDate: new Date(),
      paymentType: "Card",
      paymentAmount: 400,
      status,
      method: "CARD",
      processorType: "STRIPE",
      processorTxnId,
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each([
  ["Stripe", stripeWebhook, "/api/stripe/webhook"],
  ["Square", squareWebhook, "/api/square/webhook"],
])("%s webhook: a paid checkout with no PENDING row", (processor, webhook, url) => {
  beforeEach(async () => {
    await resetTestDb();
    jest.mocked(reportOpsAlert).mockClear();
  });

  it("alerts when the session's row was VOIDED, naming the payment, amount and order", async () => {
    const order = await seedOrder();
    const voided = await seedPayment(
      { salesOrderId: order.id, customerId: order.customerId },
      "VOIDED",
      "txn_paid_anyway",
    );
    mockCompletion = { providerTxnId: "txn_paid_anyway", metadata: { orderId: String(order.id) } };

    const res = await deliver(webhook, url);

    expect(res.statusCode).toBe(200);
    expect(reportOpsAlert).toHaveBeenCalledTimes(1);
    expect(reportOpsAlert).toHaveBeenCalledWith({
      title: `${processor} took a payment Holt had stopped tracking`,
      detail: expect.stringContaining("never posted to the books"),
      context: expect.objectContaining({
        paymentId: voided.id,
        status: "VOIDED",
        amount: 400,
        salesOrderId: order.id,
        invoiceId: null,
      }),
    });
    // Reported, never recorded: the row stays VOIDED and nothing is ledgered.
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: voided.id } })).status).toBe(
      "VOIDED",
    );
    expect(await prisma.customerLedgerEntry.count()).toBe(0);
  });

  it("alerts when the stale sweep had marked an invoice's row FAILED, naming the invoice", async () => {
    const invoice = await prisma.invoice.create({
      data: { invoiceNo: "INV-UNTRACKED-1", invoiceDate: new Date("2026-10-01"), taxAmount: 0 },
    });
    const failed = await seedPayment({ invoiceId: invoice.id }, "FAILED", "txn_swept_then_paid");
    mockCompletion = {
      providerTxnId: "txn_swept_then_paid",
      metadata: { invoiceId: String(invoice.id) },
    };

    await deliver(webhook, url);

    expect(reportOpsAlert).toHaveBeenCalledTimes(1);
    expect(jest.mocked(reportOpsAlert).mock.calls[0][0].context).toMatchObject({
      paymentId: failed.id,
      status: "FAILED",
      invoiceId: invoice.id,
    });
  });

  it("stays silent for a retry of a payment already COMPLETED", async () => {
    const order = await seedOrder();
    await seedPayment({ salesOrderId: order.id }, "COMPLETED", "txn_retry");
    mockCompletion = { providerTxnId: "txn_retry", metadata: { orderId: String(order.id) } };

    const res = await deliver(webhook, url);

    expect(res.statusCode).toBe(200);
    expect(reportOpsAlert).not.toHaveBeenCalled();
  });

  it("stays silent for a session Holt never had a row for", async () => {
    mockCompletion = { providerTxnId: "txn_unknown", metadata: { orderId: "999999" } };

    const res = await deliver(webhook, url);

    expect(res.statusCode).toBe(200);
    expect(reportOpsAlert).not.toHaveBeenCalled();
  });
});
