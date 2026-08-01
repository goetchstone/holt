// /app/__tests__/paymentProviderSeam.test.ts
//
// Behavioural coverage for the payment-provider seam (lib/payments/index.ts).
// Two questions get asked of that module and conflating them is the classic
// multi-processor bug: "which processor takes a NEW payment" (an operator
// choice, getActiveProvider) vs. "which processor handled THIS EXISTING
// payment" (a historical fact read off Payment.processorType,
// getProviderForPayment). The tests below exercise both, plus the capability
// guard, using a fake PaymentProvider — no network, no Stripe SDK.

import {
  assertCapability,
  getActiveProviderId,
  getProviderForPayment,
  type PaymentProvider,
} from "@/lib/payments";
import { stripeProvider } from "@/lib/payments/stripeProvider";

describe("getProviderForPayment", () => {
  it("resolves a payment processed by Stripe (uppercase, as stored on Payment rows)", () => {
    expect(getProviderForPayment("STRIPE")).toBe(stripeProvider);
  });

  it("resolves lowercase too — the lookup is case-insensitive", () => {
    expect(getProviderForPayment("stripe")).toBe(stripeProvider);
  });

  it("falls back to Stripe for null (legacy rows predate multi-provider)", () => {
    expect(getProviderForPayment(null)).toBe(stripeProvider);
  });

  it("falls back to Stripe for undefined", () => {
    expect(getProviderForPayment(undefined)).toBe(stripeProvider);
  });

  it("throws a clear error for SQUARE while Square is unregistered in this build", () => {
    expect(() => getProviderForPayment("SQUARE")).toThrow(/not available in this build/i);
  });

  it("throws rather than silently defaulting for an unknown, non-null processor", () => {
    // Refunding through the wrong processor is worse than a clear failure —
    // an unrecognised value must never quietly resolve to Stripe.
    expect(() => getProviderForPayment("paypal")).toThrow(/cannot service/i);
  });
});

describe("assertCapability", () => {
  const fakeProvider: PaymentProvider = {
    id: "stripe",
    displayName: "FakeProvider",
    capabilities: { hostedCheckout: true, terminal: false, refunds: true },
    async testConnection() {
      return { ok: true, message: "fake" };
    },
  };

  it("throws a readable message for an unsupported capability", () => {
    expect(() => assertCapability(fakeProvider, "terminal")).toThrow(
      /FakeProvider does not support terminal/,
    );
  });

  it("passes silently for a supported capability", () => {
    expect(() => assertCapability(fakeProvider, "hostedCheckout")).not.toThrow();
  });

  it("real Stripe provider declares no terminal support, per its documented client-driven SDK constraint", () => {
    expect(() => assertCapability(stripeProvider, "terminal")).toThrow(
      /Stripe does not support terminal/,
    );
    expect(() => assertCapability(stripeProvider, "hostedCheckout")).not.toThrow();
  });
});

describe("getActiveProviderId", () => {
  const ORIGINAL_ENV = process.env.PAYMENT_PROVIDER;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.PAYMENT_PROVIDER;
    } else {
      process.env.PAYMENT_PROVIDER = ORIGINAL_ENV;
    }
  });

  it("defaults to stripe when PAYMENT_PROVIDER is unset", () => {
    delete process.env.PAYMENT_PROVIDER;
    expect(getActiveProviderId()).toBe("stripe");
  });

  it("defaults to stripe when PAYMENT_PROVIDER is garbage", () => {
    process.env.PAYMENT_PROVIDER = "not-a-real-processor";
    expect(getActiveProviderId()).toBe("stripe");
  });

  it("honours a valid PAYMENT_PROVIDER override", () => {
    process.env.PAYMENT_PROVIDER = "square";
    expect(getActiveProviderId()).toBe("square");
  });

  it("is case-insensitive and trims whitespace", () => {
    process.env.PAYMENT_PROVIDER = "  SQUARE  ";
    expect(getActiveProviderId()).toBe("square");
  });
});

describe("routing invariant: existing payments route on processorType, never on the active provider", () => {
  const ORIGINAL_ENV = process.env.PAYMENT_PROVIDER;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.PAYMENT_PROVIDER;
    } else {
      process.env.PAYMENT_PROVIDER = ORIGINAL_ENV;
    }
  });

  it("a Stripe-processed payment still resolves to Stripe even when the active provider is switched away", () => {
    // If an org flips the active provider (e.g. to Square), a payment that
    // was ALREADY captured by Stripe must still refund/resolve through
    // Stripe — routing it to the new active provider would send a refund to
    // a processor that never took the money.
    process.env.PAYMENT_PROVIDER = "square";
    expect(getActiveProviderId()).toBe("square"); // sanity: override took effect
    expect(getProviderForPayment("STRIPE")).toBe(stripeProvider);
  });

  it("holds even when the active-provider override is garbage", () => {
    process.env.PAYMENT_PROVIDER = "totally-unknown";
    expect(getProviderForPayment("stripe")).toBe(stripeProvider);
  });
});
