// /app/__tests__/stripeCardReader.test.ts
//
// stripeProvider's card-reader methods against a stand-in Stripe client: what
// is sent to Stripe for a reader payment, and how Stripe's answers are read.
// The mapping is the logic; the network is not under test here, and no part of
// this has run against Stripe itself (docs/domains/pos.md, "Card readers").

import { READER_PAYMENT_FLAG, stripeProvider } from "@/lib/payments/stripeProvider";
import type { VerifiedWebhookEvent } from "@/lib/payments/types";

const stripe = {
  paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() },
  terminal: {
    readers: {
      processPaymentIntent: jest.fn(),
      retrieve: jest.fn(),
      cancelAction: jest.fn(),
    },
  },
  checkout: { sessions: { retrieve: jest.fn() } },
  refunds: { create: jest.fn() },
};

jest.mock("@/lib/stripe", () => ({ getStripe: async () => stripe }));

beforeEach(() => {
  jest.resetAllMocks();
});

describe("createTerminalCheckout", () => {
  it("creates a card_present payment in minor units, flagged as Holt's, and hands it to the reader", async () => {
    stripe.paymentIntents.create.mockResolvedValue({ id: "pi_1" });
    stripe.terminal.readers.processPaymentIntent.mockResolvedValue({});

    const result = await stripeProvider.createTerminalCheckout!({
      amount: 1234.5,
      currency: "USD",
      deviceId: "tmr_1",
      referenceId: "Order HH-1",
      metadata: { orderId: "7" },
    });

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith({
      amount: 123450,
      currency: "usd",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      description: "Order HH-1",
      metadata: { orderId: "7", [READER_PAYMENT_FLAG]: "1" },
    });
    expect(stripe.terminal.readers.processPaymentIntent).toHaveBeenCalledWith("tmr_1", {
      payment_intent: "pi_1",
    });
    expect(result).toEqual({ providerTxnId: "pi_1", status: "PENDING" });
  });

  it("cancels the payment when the reader refuses it, and passes the refusal on", async () => {
    stripe.paymentIntents.create.mockResolvedValue({ id: "pi_2" });
    stripe.terminal.readers.processPaymentIntent.mockRejectedValue(new Error("Reader is offline"));
    stripe.paymentIntents.cancel.mockResolvedValue({});

    await expect(
      stripeProvider.createTerminalCheckout!({ amount: 10, currency: "USD", deviceId: "tmr_1" }),
    ).rejects.toThrow("Reader is offline");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_2");
  });
});

describe("getTerminalCheckout", () => {
  it("reads a succeeded payment as COMPLETED with the card's brand and last four", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      latest_charge: {
        payment_method_details: { card_present: { brand: "visa", last4: "4242" } },
      },
    });
    const result = await stripeProvider.getTerminalCheckout!("pi_1", "tmr_1");
    expect(result).toMatchObject({
      providerTxnId: "pi_1",
      status: "COMPLETED",
      cardBrand: "visa",
      cardLast4: "4242",
    });
    expect(stripe.terminal.readers.retrieve).not.toHaveBeenCalled();
  });

  it("reads a declined card as FAILED with Stripe's reason", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
      last_payment_error: { message: "Your card was declined." },
    });
    await expect(stripeProvider.getTerminalCheckout!("pi_1", "tmr_1")).resolves.toEqual({
      providerTxnId: "pi_1",
      status: "FAILED",
      message: "Your card was declined.",
    });
  });

  it("reads a reader action that failed on this payment as FAILED", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
      last_payment_error: null,
    });
    stripe.terminal.readers.retrieve.mockResolvedValue({
      action: {
        status: "failed",
        failure_message: "The customer cancelled.",
        process_payment_intent: { payment_intent: "pi_1" },
      },
    });
    await expect(stripeProvider.getTerminalCheckout!("pi_1", "tmr_1")).resolves.toMatchObject({
      status: "FAILED",
      message: "The customer cancelled.",
    });
  });

  it("does not read another payment's failed action as this one's", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
      last_payment_error: null,
    });
    stripe.terminal.readers.retrieve.mockResolvedValue({
      action: { status: "failed", process_payment_intent: { payment_intent: "pi_other" } },
    });
    await expect(stripeProvider.getTerminalCheckout!("pi_1", "tmr_1")).resolves.toEqual({
      providerTxnId: "pi_1",
      status: "PENDING",
    });
  });

  it("reads a payment still on the reader as PENDING, and a cancelled one as CANCELED", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
      last_payment_error: null,
    });
    stripe.terminal.readers.retrieve.mockResolvedValue({
      action: { status: "in_progress", process_payment_intent: { payment_intent: "pi_1" } },
    });
    await expect(stripeProvider.getTerminalCheckout!("pi_1", "tmr_1")).resolves.toMatchObject({
      status: "PENDING",
    });

    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "canceled" });
    await expect(stripeProvider.getTerminalCheckout!("pi_1", "tmr_1")).resolves.toMatchObject({
      status: "CANCELED",
    });
  });
});

describe("cancelTerminalCheckout", () => {
  it("clears the reader and cancels the payment, and a refusal of either is not an error", async () => {
    stripe.terminal.readers.cancelAction.mockRejectedValue(new Error("terminal_reader_busy"));
    stripe.paymentIntents.cancel.mockRejectedValue(new Error("already succeeded"));
    await expect(stripeProvider.cancelTerminalCheckout!("pi_1", "tmr_1")).resolves.toBeUndefined();
    expect(stripe.terminal.readers.cancelAction).toHaveBeenCalledWith("tmr_1");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });
});

describe("extractCompletion for a reader payment", () => {
  const event = (metadata: Record<string, string>): VerifiedWebhookEvent => ({
    providerId: "stripe",
    type: "payment_intent.succeeded",
    raw: { type: "payment_intent.succeeded", data: { object: { id: "pi_9", metadata } } },
  });

  it("completes a payment Holt sent to a reader, keyed by the payment intent", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_9",
      latest_charge: {
        payment_method_details: { card_present: { brand: "mastercard", last4: "4444" } },
      },
    });
    const completion = await stripeProvider.extractCompletion!(
      event({ orderId: "12", [READER_PAYMENT_FLAG]: "1" }),
    );
    expect(completion).toMatchObject({
      providerTxnId: "pi_9",
      metadata: { orderId: "12" },
      cardBrand: "mastercard",
      cardLast4: "4444",
    });
  });

  it("ignores a payment intent Holt did not send to a reader (a hosted checkout's)", async () => {
    await expect(stripeProvider.extractCompletion!(event({}))).resolves.toBeNull();
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe("refund", () => {
  it("refunds a reader payment by its payment intent, with no checkout session lookup", async () => {
    stripe.refunds.create.mockResolvedValue({ id: "re_1" });
    const result = await stripeProvider.refund!({
      providerTxnId: "pi_1",
      amount: 25,
      idempotencyKey: "holt-refund-3",
    });
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1", amount: 2500 }),
      expect.objectContaining({ idempotencyKey: "holt-refund-3" }),
    );
    expect(result).toEqual({ refundId: "re_1" });
  });

  it("still resolves a hosted checkout's session to its payment intent", async () => {
    stripe.checkout.sessions.retrieve.mockResolvedValue({ payment_intent: "pi_from_session" });
    stripe.refunds.create.mockResolvedValue({ id: "re_2" });
    await stripeProvider.refund!({
      providerTxnId: "cs_test_1",
      amount: 5,
      idempotencyKey: "holt-refund-4",
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_from_session" }),
      expect.anything(),
    );
  });
});
