// /app/__tests__/integration/cardReaderPayments.integration.test.ts
//
// A card payment on a register's reader, against the real database and a
// stand-in for Stripe: what reaches the books and when. The stand-in holds
// payment intents and one reader the way Stripe's server-driven Terminal API
// answers for them; none of this has run against Stripe itself
// (docs/domains/pos.md, "Card readers").
//
// Why real-DB: the point of the flow is that a payment out on the reader is
// PENDING with nothing in the ledger, and that exactly one of the register's
// ask and the webhook posts it. Both are conditional updates and ledger rows.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  cancelReaderPayment,
  presentTestCard,
  settleReaderPayment,
  startReaderPayment,
} from "@/lib/payments/cardReaderPayments";
import {
  CheckoutAlreadyOpenError,
  calculateOrderBalance,
  completePayment,
  recordPendingPayment,
  startHostedCheckout,
} from "@/lib/paymentService";

interface FakeIntent {
  id: string;
  amount: number;
  status: string;
  last_payment_error: { message: string } | null;
  latest_charge: unknown;
  metadata: Record<string, string>;
}

const fake = {
  intents: new Map<string, FakeIntent>(),
  readerAction: null as null | {
    status: string;
    failure_message?: string;
    process_payment_intent: { payment_intent: string };
  },
  readerOffline: false,
  /** A card being authorized: neither the reader nor the payment can be stopped. */
  authorizing: false,
  seq: 0,
};

function approve(id: string) {
  const intent = fake.intents.get(id)!;
  intent.status = "succeeded";
  intent.latest_charge = {
    payment_method_details: { card_present: { brand: "visa", last4: "4242" } },
  };
  fake.readerAction = { status: "succeeded", process_payment_intent: { payment_intent: id } };
}

function decline(id: string, message: string) {
  const intent = fake.intents.get(id)!;
  intent.last_payment_error = { message };
  fake.readerAction = {
    status: "failed",
    failure_message: message,
    process_payment_intent: { payment_intent: id },
  };
}

const stripe = {
  paymentIntents: {
    create: async (params: { amount: number; metadata: Record<string, string> }) => {
      const intent: FakeIntent = {
        id: `pi_test_${++fake.seq}`,
        amount: params.amount,
        status: "requires_payment_method",
        last_payment_error: null,
        latest_charge: null,
        metadata: params.metadata,
      };
      fake.intents.set(intent.id, intent);
      return intent;
    },
    retrieve: async (id: string) => fake.intents.get(id)!,
    cancel: async (id: string) => {
      const intent = fake.intents.get(id)!;
      if (intent.status === "succeeded" || fake.authorizing) {
        throw new Error("This PaymentIntent cannot be canceled.");
      }
      intent.status = "canceled";
      return intent;
    },
  },
  terminal: {
    readers: {
      processPaymentIntent: async (_reader: string, params: { payment_intent: string }) => {
        if (fake.readerOffline) throw new Error("Reader is currently offline.");
        fake.readerAction = {
          status: "in_progress",
          process_payment_intent: { payment_intent: params.payment_intent },
        };
        return {};
      },
      retrieve: async () => ({ action: fake.readerAction }),
      cancelAction: async () => {
        if (fake.authorizing) throw new Error("terminal_reader_busy");
        fake.readerAction = null;
        return {};
      },
    },
  },
  testHelpers: {
    terminal: {
      readers: {
        presentPaymentMethod: async () => {
          approve(fake.readerAction!.process_payment_intent.payment_intent);
          return {};
        },
      },
    },
  },
};

jest.mock("@/lib/stripe", () => ({ getStripe: async () => stripe }));
// The steps after a payment (a quote becoming an order, its purchase orders)
// have their own tests; here they would only need more seed.
jest.mock("@/lib/serviceDispatchService", () => ({ syncServiceAppointments: jest.fn() }));

async function seed(opts: { deviceType?: string } = {}) {
  const store = await prisma.storeLocation.create({
    data: { name: "Reader Test Store", code: "RTS", type: "STORE" },
  });
  const register = await prisma.register.create({
    data: { name: "Front counter", storeLocationId: store.id },
  });
  const cashier = await prisma.staffMember.create({
    data: { displayName: "Reader Cashier", role: "REGISTER" },
  });
  const till = await prisma.till.create({
    data: { registerId: register.id, status: "OPEN", openingCash: 100, openedById: cashier.id },
  });
  const reader = await prisma.cardReader.create({
    data: {
      label: "Counter reader",
      registerId: register.id,
      processorType: "STRIPE",
      processorReaderId: "tmr_test_1",
      deviceType: opts.deviceType ?? "stripe_s700",
    },
  });
  const customer = await prisma.customer.create({
    data: { firstName: "Reader", lastName: "Customer" },
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "READER-01",
      status: "ORDER",
      orderDate: new Date("2026-11-01"),
      customerId: customer.id,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            partNo: "ITEM-1",
            netPrice: 500,
            cost: 200,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
  return { register, till, reader, customer, order };
}

const ledgerRows = (paymentId: number) =>
  prisma.customerLedgerEntry.count({ where: { paymentId } });

describe("a card payment on a register's reader (real DB, stand-in Stripe)", () => {
  beforeEach(async () => {
    await resetTestDb();
    fake.intents.clear();
    fake.readerAction = null;
    fake.readerOffline = false;
    fake.authorizing = false;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is PENDING with nothing in the books while the reader waits for the card", async () => {
    const { order, register, till } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      tillId: till.id,
      actor: "cashier@example.com",
    });

    expect(started).toMatchObject({
      status: "WAITING",
      amount: 200,
      readerLabel: "Counter reader",
      simulated: false,
    });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } });
    expect(row).toMatchObject({
      status: "PENDING",
      method: "CARD",
      processorType: "STRIPE",
      registerId: register.id,
      tillId: till.id,
      createdBy: "cashier@example.com",
    });
    expect(row.processorTxnId).toMatch(/^pi_test_/);
    expect(await ledgerRows(row.id)).toBe(0);
    expect((await calculateOrderBalance(order.id)).totalPaid).toBe(0);
    expect((await settleReaderPayment(row.id)).status).toBe("WAITING");
  });

  it("posts the payment once when the card is approved, however often it is asked", async () => {
    const { order, register, till } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      tillId: till.id,
      actor: "cashier@example.com",
    });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } });
    approve(row.processorTxnId!);

    const [first, second] = await Promise.all([
      settleReaderPayment(row.id),
      settleReaderPayment(row.id),
    ]);
    const third = await settleReaderPayment(row.id);

    for (const state of [first, second, third]) expect(state.status).toBe("APPROVED");
    expect(third).toMatchObject({ cardBrand: "visa", cardLast4: "4242" });
    expect(await ledgerRows(row.id)).toBe(1);
    const balance = await calculateOrderBalance(order.id);
    expect(balance.totalPaid).toBe(200);
    expect(balance.balanceDue).toBe(300);
  });

  it("posts nothing more when the webhook's completion lands first", async () => {
    const { order, register } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 500,
      registerId: register.id,
      actor: null,
    });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } });
    approve(row.processorTxnId!);
    await completePayment(row.id, { cardBrand: "visa", cardLast4: "4242" });

    expect((await settleReaderPayment(row.id)).status).toBe("APPROVED");
    expect(await ledgerRows(row.id)).toBe(1);
    expect((await calculateOrderBalance(order.id)).totalPaid).toBe(500);
  });

  it("fails a declined payment, cancels it at the processor, and lets the next try through", async () => {
    const { order, register } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } });
    decline(row.processorTxnId!, "Your card was declined.");

    const state = await settleReaderPayment(row.id);
    expect(state).toMatchObject({ status: "DECLINED", message: "Your card was declined." });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "FAILED",
    );
    // Still payable at the processor until cancelled: it must not be left so.
    expect(fake.intents.get(row.processorTxnId!)!.status).toBe("canceled");
    expect(await ledgerRows(row.id)).toBe(0);
    // Asked again later, it still says why.
    expect(await settleReaderPayment(row.id)).toMatchObject({
      status: "DECLINED",
      message: "Your card was declined.",
    });

    const retry = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    expect(retry.status).toBe("WAITING");
    expect(retry.paymentId).not.toBe(row.id);
  });

  it("picks up the payment already on the reader instead of sending a second", async () => {
    const { order, register } = await seed();
    const first = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    const again = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    expect(again.paymentId).toBe(first.paymentId);
    expect(fake.intents.size).toBe(1);
    expect(await prisma.payment.count({ where: { salesOrderId: order.id } })).toBe(1);
  });

  it("cancels a payment the customer has not paid: voided here, cancelled there", async () => {
    const { order, register } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } });

    const state = await cancelReaderPayment(row.id, "cashier@example.com");
    expect(state.status).toBe("CANCELED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "VOIDED",
    );
    expect(fake.intents.get(row.processorTxnId!)!.status).toBe("canceled");
    expect(fake.readerAction).toBeNull();
    expect(await ledgerRows(row.id)).toBe(0);
  });

  it("records a card that went through before the cancel, instead of voiding it", async () => {
    const { order, register } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } });
    approve(row.processorTxnId!);

    const state = await cancelReaderPayment(row.id, "cashier@example.com");
    expect(state.status).toBe("APPROVED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "COMPLETED",
    );
    expect(await ledgerRows(row.id)).toBe(1);
  });

  it("keeps waiting when a card being authorized cannot be stopped", async () => {
    const { order, register } = await seed();
    const started = await startReaderPayment(order.id, {
      amount: 200,
      registerId: register.id,
      actor: null,
    });
    fake.authorizing = true;

    const state = await cancelReaderPayment(started.paymentId, "cashier@example.com");
    expect(state.status).toBe("WAITING");
    expect(state.message).toMatch(/can't be stopped/);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: started.paymentId } })).status,
    ).toBe("PENDING");
  });

  it("refuses before anything reaches the reader: over the balance, no reader, closed till, a link open", async () => {
    const { order, register, till, reader } = await seed();
    const input = { amount: 200, registerId: register.id, actor: null };

    await expect(startReaderPayment(order.id, { ...input, amount: 500.01 })).rejects.toThrow(
      /owes \$500\.00/,
    );

    await prisma.till.update({ where: { id: till.id }, data: { status: "CLOSED" } });
    await expect(startReaderPayment(order.id, { ...input, tillId: till.id })).rejects.toThrow(
      /till isn't open/,
    );

    await prisma.cardReader.update({ where: { id: reader.id }, data: { isActive: false } });
    await expect(startReaderPayment(order.id, input)).rejects.toThrow(/no card reader/);
    await prisma.cardReader.update({ where: { id: reader.id }, data: { isActive: true } });

    const link = await recordPendingPayment(
      { orderId: order.id },
      { method: "CARD", amount: 100, processorType: "STRIPE", processorTxnId: "cs_test_link" },
    );
    await expect(startReaderPayment(order.id, input)).rejects.toThrow(/payment link/);
    await prisma.payment.update({ where: { id: link.id }, data: { status: "VOIDED" } });

    expect(fake.intents.size).toBe(0);
  });

  it("leaves no payment behind when the reader does not take it", async () => {
    const { order, register } = await seed();
    fake.readerOffline = true;
    await expect(
      startReaderPayment(order.id, { amount: 200, registerId: register.id, actor: null }),
    ).rejects.toThrow(/didn't take the payment: Reader is currently offline/);
    expect(await prisma.payment.count({ where: { salesOrderId: order.id } })).toBe(0);
    expect([...fake.intents.values()].map((i) => i.status)).toEqual(["canceled"]);
  });

  it("will not replace a payment out on the reader with a payment link, even forced", async () => {
    const { order, register } = await seed();
    await startReaderPayment(order.id, { amount: 200, registerId: register.id, actor: null });
    const link = startHostedCheckout({
      target: { orderId: order.id },
      amount: 200,
      force: true,
      description: "Order READER-01",
      metadata: { orderId: String(order.id) },
      urls: { successUrl: "https://example.com/ok", cancelUrl: "https://example.com/no" },
    });
    await expect(link).rejects.toBeInstanceOf(CheckoutAlreadyOpenError);
    await expect(link).rejects.toThrow(/card reader/);
    expect(await prisma.payment.count({ where: { status: "VOIDED" } })).toBe(0);
  });

  it("presents a test card only to a simulated reader", async () => {
    const real = await seed();
    const started = await startReaderPayment(real.order.id, {
      amount: 200,
      registerId: real.register.id,
      actor: null,
    });
    await expect(presentTestCard(started.paymentId)).rejects.toThrow(/simulated reader/);

    await prisma.cardReader.update({
      where: { id: real.reader.id },
      data: { deviceType: "simulated_wisepos_e" },
    });
    await presentTestCard(started.paymentId);
    expect((await settleReaderPayment(started.paymentId)).status).toBe("APPROVED");
  });
});
