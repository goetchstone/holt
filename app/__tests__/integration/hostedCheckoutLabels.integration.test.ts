// /app/__tests__/integration/hostedCheckoutLabels.integration.test.ts
//
// Every online card payment starts through paymentService.startHostedCheckout,
// and every site that starts one writes the same PENDING row: labelled "Card",
// method CARD, the customer on it, bound to its order or invoice.
//
// Two histories meet here. The customer portal and the emailed payment link
// each wrote their own PENDING row and called a partial payment "Deposit". The
// label is what the sales journal maps to a GL account, so that card money
// posted to the deposit OFFSET account, and the daily reconciliation left it
// out of tender (break-apart audit item 2, step 1). And the invoice payment
// link had no second-session guard at all: every call opened a fresh checkout
// for the full open balance, so the invoice email, the client portal and the
// staff "Copy payment link" could leave parallel sessions on one invoice, any
// two of which could be paid (step 2).
//
// Real DB for the rows and the guard; the processor, the portal tokens, the
// rate limiter, the staff-session wrapper and the email queue are stubbed,
// since none of them decides the label or the refusal.

import type { NextApiRequest, NextApiResponse } from "next";
import type { CheckoutRequest, CheckoutResult } from "@/lib/payments";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

const mockCreateCheckout = jest.fn<Promise<CheckoutResult>, [CheckoutRequest]>(async () => ({
  providerTxnId: `cs_test_${Math.random().toString(36).slice(2)}`,
  url: "https://checkout.example.test/session",
}));

jest.mock("@/lib/payments", () => ({
  ...jest.requireActual("@/lib/payments"),
  assertCapability: () => undefined,
  getActiveProvider: () => ({
    id: "stripe",
    createCheckout: (req: CheckoutRequest) => mockCreateCheckout(req),
  }),
}));
jest.mock("@/lib/rateLimit", () => ({
  rateLimit: () => (handler: unknown) => handler,
}));
jest.mock("@/lib/portalToken", () => ({
  verifyPortalToken: jest.fn(),
}));
jest.mock("@/lib/clientPortalToken", () => ({
  verifyClientPortalToken: jest.fn(),
}));
jest.mock("@/lib/email/queue", () => ({
  enqueueAndSend: jest.fn(async () => undefined),
}));
jest.mock("@/lib/auth/requireAuth", () => ({
  requireAuthWithRole:
    (_roles: string[], handler: (req: unknown, res: unknown, session: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "manager@example.com" } }),
}));

import { verifyPortalToken } from "@/lib/portalToken";
import { verifyClientPortalToken } from "@/lib/clientPortalToken";
import { enqueueAndSend } from "@/lib/email/queue";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import {
  CheckoutAlreadyOpenError,
  PENDING_SESSION_LIFETIME_MS,
  findActivePendingPayment,
} from "@/lib/paymentService";
import { createInvoicePaymentLink } from "@/lib/billing/invoiceStripe";
import { sendInvoiceEmail } from "@/lib/billing/invoiceEmail";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import portalPay from "@/pages/api/portal/pay";
import sendPaymentLink from "@/pages/api/stripe/send-payment-link";
import createCheckout from "@/pages/api/stripe/create-checkout";
import clientPortalPay from "@/pages/api/client-portal/pay";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

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

async function post(handler: unknown, body: Record<string, unknown>) {
  const res = mockRes();
  await (handler as Handler)(
    { method: "POST", body, headers: {} } as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

async function seedSettings(features: Record<string, boolean> = {}) {
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  await prisma.appSettings.create({
    data: { organizationId: 1, appName: "Test Co", features },
  });
  invalidateAppSettingsCache();
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

/** An issued, authored invoice with $500 open. Needs seedSettings() first
 *  (organizationId 1). */
async function seedInvoice(invoiceNo: string) {
  const customer = await prisma.customer.create({
    data: { firstName: "Cal", lastName: "Reyes", email: "cal@example.com" },
  });
  return prisma.invoice.create({
    data: {
      invoiceNo,
      invoiceDate: new Date("2026-10-01"),
      taxAmount: 0,
      total: 500,
      status: "ISSUED",
      issuedAt: new Date("2026-10-01"),
      organizationId: 1,
      customerId: customer.id,
      lineItems: {
        create: [{ description: "Design consult", quantity: 1, unitPrice: 500, amount: 500 }],
      },
    },
  });
}

async function seedInvoicePayment(
  invoice: { id: number; customerId: number | null },
  opts: { ageMs: number; isRefund?: boolean },
) {
  return prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      paymentDate: new Date(Date.now() - opts.ageMs),
      paymentType: "Card",
      paymentAmount: 500,
      status: "PENDING",
      method: "CARD",
      isRefund: opts.isRefund ?? false,
      processorType: "STRIPE",
      processorTxnId: `cs_test_seed_${invoice.id}_${opts.ageMs}`,
    },
  });
}

const rowSelect = {
  id: true,
  paymentType: true,
  method: true,
  paymentAmount: true,
  customerId: true,
  salesOrderId: true,
  invoiceId: true,
  processorType: true,
  createdBy: true,
} as const;

async function pendingRowFor(where: { salesOrderId: number } | { invoiceId: number }) {
  return prisma.payment.findFirstOrThrow({
    where: { ...where, status: "PENDING" },
    select: rowSelect,
  });
}

async function pendingCount(where: { salesOrderId: number } | { invoiceId: number }) {
  return prisma.payment.count({ where: { ...where, status: "PENDING" } });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateAppSettingsCache();
  mockCreateCheckout.mockClear();
  jest.mocked(enqueueAndSend).mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("every hosted card checkout writes a Card row bound to its target (real DB)", () => {
  it("portal Pay: a partial payment is a Card payment with the customer on it", async () => {
    const order = await seedOrder("Q-PORTAL-1");
    jest.mocked(verifyPortalToken).mockReturnValue({ orderId: order.id } as never);

    const res = await post(portalPay, { token: "t", amount: 250 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ isDeposit: true, amount: 250 });
    const row = await pendingRowFor({ salesOrderId: order.id });
    expect(row).toMatchObject({
      paymentType: "Card",
      method: "CARD",
      customerId: order.customerId,
      invoiceId: null,
      processorType: "STRIPE",
      createdBy: "customer-portal",
    });
    expect(Number(row.paymentAmount)).toBe(250);
  });

  it("emailed payment link: a partial payment is a Card payment with the customer on it", async () => {
    const order = await seedOrder("Q-LINK-1");

    const res = await post(sendPaymentLink, { orderId: order.id, amount: 300 });

    expect(res.statusCode).toBe(200);
    const row = await pendingRowFor({ salesOrderId: order.id });
    expect(row).toMatchObject({
      paymentType: "Card",
      method: "CARD",
      customerId: order.customerId,
      invoiceId: null,
      processorType: "STRIPE",
      createdBy: "manager@example.com",
    });
    expect(Number(row.paymentAmount)).toBe(300);
  });

  it("staff checkout: the full balance is a Card payment with the customer on it", async () => {
    const order = await seedOrder("Q-CHECKOUT-1");

    const res = await post(createCheckout, { orderId: order.id });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ url: "https://checkout.example.test/session" });
    const row = await pendingRowFor({ salesOrderId: order.id });
    expect(row).toMatchObject({
      paymentType: "Card",
      method: "CARD",
      customerId: order.customerId,
      invoiceId: null,
      processorType: "STRIPE",
      createdBy: "manager@example.com",
    });
    expect(Number(row.paymentAmount)).toBe(1000);
  });

  it("invoice link: the open balance is a Card payment bound to the invoice, not an order", async () => {
    await seedSettings({ clientPortal: true });
    const invoice = await seedInvoice("INV-LABEL-1");
    jest
      .mocked(verifyClientPortalToken)
      .mockReturnValue({ customerId: invoice.customerId } as never);

    const res = await post(clientPortalPay, { token: "t", invoiceId: invoice.id });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ amount: 500 });
    const row = await pendingRowFor({ invoiceId: invoice.id });
    expect(row).toMatchObject({
      paymentType: "Card",
      method: "CARD",
      customerId: invoice.customerId,
      salesOrderId: null,
      processorType: "STRIPE",
      createdBy: "client-portal",
    });
    expect(Number(row.paymentAmount)).toBe(500);
  });

  it("an order checkout charges in the deployment's currency, not a USD literal", async () => {
    await seedSettings();
    await prisma.appSettings.update({ where: { organizationId: 1 }, data: { currency: "CAD" } });
    invalidateAppSettingsCache();
    const order = await seedOrder("Q-CAD-1");

    const res = await post(createCheckout, { orderId: order.id });

    expect(res.statusCode).toBe(200);
    expect(mockCreateCheckout).toHaveBeenCalledWith(expect.objectContaining({ currency: "CAD" }));
  });
});

describe("one open checkout per order or invoice (real DB)", () => {
  it("the order routes keep their 409 + existingPayment answer", async () => {
    const order = await seedOrder("Q-TWICE-1");
    const first = await post(sendPaymentLink, { orderId: order.id, amount: 300 });
    expect(first.statusCode).toBe(200);

    const second = await post(createCheckout, { orderId: order.id });

    expect(second.statusCode).toBe(409);
    expect(second.body).toMatchObject({
      error: expect.stringMatching(
        /^A payment link for \$300\.00 is already open on this order \(started \d+ min ago\)/,
      ),
      existingPayment: { amount: 300 },
    });
    expect(await pendingCount({ salesOrderId: order.id })).toBe(1);
  });

  it("a second invoice link while one is open is refused, naming its amount and age", async () => {
    await seedSettings();
    const invoice = await seedInvoice("INV-GUARD-1");
    await createInvoicePaymentLink(invoice.id, "staff@example.com");

    const second = createInvoicePaymentLink(invoice.id, "staff@example.com");

    await expect(second).rejects.toBeInstanceOf(CheckoutAlreadyOpenError);
    await expect(second).rejects.toMatchObject({
      existing: { amount: 500, ageMinutes: expect.any(Number) },
      message: expect.stringMatching(
        /^A payment link for \$500\.00 is already open on this invoice \(started \d+ min ago\)/,
      ),
    });
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
    expect(await pendingCount({ invoiceId: invoice.id })).toBe(1);
  });

  it("force voids the open invoice checkout and starts a new one", async () => {
    await seedSettings();
    const invoice = await seedInvoice("INV-FORCE-1");
    await createInvoicePaymentLink(invoice.id, "staff@example.com");
    const first = await pendingRowFor({ invoiceId: invoice.id });

    await createInvoicePaymentLink(invoice.id, "staff@example.com", { force: true });

    const voided = await prisma.payment.findUniqueOrThrow({ where: { id: first.id } });
    expect(voided.status).toBe("VOIDED");
    expect(voided.updatedBy).toBe("staff@example.com");
    const replacement = await pendingRowFor({ invoiceId: invoice.id });
    expect(replacement.id).not.toBe(first.id);
    expect(await pendingCount({ invoiceId: invoice.id })).toBe(1);
  });

  it("a PENDING invoice row older than the session lifetime does not block a new link", async () => {
    await seedSettings();
    const invoice = await seedInvoice("INV-STALE-1");
    const stale = await seedInvoicePayment(invoice, {
      ageMs: PENDING_SESSION_LIFETIME_MS + 60_000,
    });

    await createInvoicePaymentLink(invoice.id, "staff@example.com");

    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
    const open = await findActivePendingPayment({ invoiceId: invoice.id });
    expect(open).not.toBeNull();
    expect(open!.id).not.toBe(stale.id);
  });

  it("a PENDING refund on the invoice is not an open checkout", async () => {
    await seedSettings();
    const invoice = await seedInvoice("INV-REFUND-1");
    await seedInvoicePayment(invoice, { ageMs: 0, isRefund: true });

    await createInvoicePaymentLink(invoice.id, "staff@example.com");

    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("client portal: 409 with the amount and age, and a force retry replaces it", async () => {
    await seedSettings({ clientPortal: true });
    const invoice = await seedInvoice("INV-PORTAL-1");
    jest
      .mocked(verifyClientPortalToken)
      .mockReturnValue({ customerId: invoice.customerId } as never);
    expect((await post(clientPortalPay, { token: "t", invoiceId: invoice.id })).statusCode).toBe(
      200,
    );

    const refused = await post(clientPortalPay, { token: "t", invoiceId: invoice.id });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatchObject({
      error: expect.stringMatching(
        /^A payment of \$500\.00 is already in progress on this invoice \(started \d+ min ago\)/,
      ),
      existingPayment: { amount: 500 },
    });

    const forced = await post(clientPortalPay, { token: "t", invoiceId: invoice.id, force: true });

    expect(forced.statusCode).toBe(200);
    expect(await pendingCount({ invoiceId: invoice.id })).toBe(1);
    expect(await prisma.payment.count({ where: { invoiceId: invoice.id, status: "VOIDED" } })).toBe(
      1,
    );
  });

  it("staff tRPC paymentLink: CONFLICT in plain words, and force replaces it", async () => {
    await seedSettings({ billing: true });
    const user = await prisma.user.create({
      data: { id: "test-user-billing", email: "billing@test.holt" },
    });
    await prisma.staffMember.create({
      data: {
        displayName: "Billing Manager",
        email: user.email ?? undefined,
        role: "MANAGER" as never,
        isActive: true,
        userId: user.id,
      },
    });
    const caller = createCallerFactory(appRouter)({
      userId: user.id,
      userEmail: user.email,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    });
    const invoice = await seedInvoice("INV-TRPC-1");
    await caller.billing.paymentLink({ id: invoice.id });

    // The screen asks before replacing, so the message only says what is
    // open; the HTTP routes' "retry with force:true" never reaches staff.
    await expect(caller.billing.paymentLink({ id: invoice.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(
        /^A payment link for \$500\.00 is already open on this invoice \(started \d+ min ago\)\.$/,
      ),
    });

    const forced = await caller.billing.paymentLink({ id: invoice.id, force: true });

    expect(forced).toMatchObject({ amount: 500 });
    expect(await pendingCount({ invoiceId: invoice.id })).toBe(1);
  });

  it("an open checkout does not block the invoice email: it goes without the pay button", async () => {
    await seedSettings();
    const invoice = await seedInvoice("INV-EMAIL-1");
    await createInvoicePaymentLink(invoice.id, "staff@example.com");

    const sent = await sendInvoiceEmail(invoice.id, {
      includePaymentLink: true,
      requestedBy: "staff@example.com",
    });

    expect(sent).toEqual({ to: "cal@example.com", paymentUrl: null });
    expect(enqueueAndSend).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1);
    expect(await pendingCount({ invoiceId: invoice.id })).toBe(1);
  });
});
