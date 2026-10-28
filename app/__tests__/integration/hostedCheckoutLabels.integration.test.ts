// /app/__tests__/integration/hostedCheckoutLabels.integration.test.ts
//
// A card payment started from the customer portal or an emailed payment link
// is labelled "Card", never "Deposit". Both routes wrote their own PENDING row
// and called a partial payment "Deposit". The label is what the sales journal
// maps to a GL account, so that card money posted to the deposit OFFSET
// account, and the daily reconciliation left it out of tender (break-apart
// audit item 2, step 1). Both now write through recordPendingPayment, which
// labels by method and fills the customer.
//
// Real DB for the row itself; the processor, the portal token, the rate
// limiter and the staff-session wrapper are stubbed, since none of them
// decides the label.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

jest.mock("@/lib/payments", () => ({
  assertCapability: () => undefined,
  getActiveProvider: () => ({
    id: "stripe",
    createCheckout: jest.fn(async () => ({
      providerTxnId: `cs_test_${Math.random().toString(36).slice(2)}`,
      url: "https://checkout.example.test/session",
    })),
  }),
}));
jest.mock("@/lib/rateLimit", () => ({
  rateLimit: () => (handler: unknown) => handler,
}));
jest.mock("@/lib/portalToken", () => ({
  verifyPortalToken: jest.fn(),
}));
jest.mock("@/lib/auth/requireAuth", () => ({
  requireAuthWithRole:
    (_roles: string[], handler: (req: unknown, res: unknown, session: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "manager@example.com" } }),
}));

import { verifyPortalToken } from "@/lib/portalToken";
import portalPay from "@/pages/api/portal/pay";
import sendPaymentLink from "@/pages/api/stripe/send-payment-link";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
    setHeader(name: string, value: unknown) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
}

async function seedOrder(orderno: string) {
  const customer = await prisma.customer.create({
    data: { firstName: "Ada", lastName: "Byrne", email: "ada@example.com" },
  });
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: new Date("2026-10-01"),
      customerId: customer.id,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            partNo: "SOFA-1",
            productName: "Linen Sofa",
            netPrice: 1000,
            cost: 400,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
}

async function pendingRowFor(orderId: number) {
  return prisma.payment.findFirstOrThrow({
    where: { salesOrderId: orderId, status: "PENDING" },
    select: { paymentType: true, method: true, paymentAmount: true, customerId: true },
  });
}

describe("hosted card checkout labels the payment by its method (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("portal Pay: a partial payment is a Card payment with the customer on it", async () => {
    const order = await seedOrder("Q-PORTAL-1");
    jest.mocked(verifyPortalToken).mockReturnValue({ orderId: order.id } as never);

    const res = mockRes();
    await (portalPay as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      { method: "POST", body: { token: "t", amount: 250 }, headers: {} } as NextApiRequest,
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ isDeposit: true, amount: 250 });
    const row = await pendingRowFor(order.id);
    expect(row.paymentType).toBe("Card");
    expect(row.method).toBe("CARD");
    expect(Number(row.paymentAmount)).toBe(250);
    expect(row.customerId).toBe(order.customerId);
  });

  it("emailed payment link: a partial payment is a Card payment with the customer on it", async () => {
    const order = await seedOrder("Q-LINK-1");

    const res = mockRes();
    await (sendPaymentLink as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      { method: "POST", body: { orderId: order.id, amount: 300 }, headers: {} } as NextApiRequest,
      res as unknown as NextApiResponse,
    );

    expect(res.statusCode).toBe(200);
    const row = await pendingRowFor(order.id);
    expect(row.paymentType).toBe("Card");
    expect(row.method).toBe("CARD");
    expect(Number(row.paymentAmount)).toBe(300);
    expect(row.customerId).toBe(order.customerId);
  });
});
