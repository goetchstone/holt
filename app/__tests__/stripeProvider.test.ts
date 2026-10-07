// /app/__tests__/stripeProvider.test.ts
//
// Behavioural coverage for stripeProvider.extractExpiration. No network:
// the early-return for a non-expiration event type, and the id extraction
// for an actual checkout.session.expired event, are both pure given the
// already-verified event object -- no Stripe SDK call happens on this path
// (contrast extractCompletion, which does a supplementary payment-intent
// lookup; that's why there's no equivalent full stripeProvider.test.ts for
// extractCompletion). CLAUDE.md rule 14 -- test the logic, not the wrapper.

import { stripeProvider } from "@/lib/payments/stripeProvider";
import type { VerifiedWebhookEvent } from "@/lib/payments/types";

describe("stripeProvider.extractExpiration", () => {
  it("returns null for a non-expiration event type, with no network call", async () => {
    const event: VerifiedWebhookEvent = {
      providerId: "stripe",
      type: "checkout.session.completed",
      raw: { type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } },
    };
    await expect(stripeProvider.extractExpiration!(event)).resolves.toBeNull();
  });

  it("returns null for an unrelated event type", async () => {
    const event: VerifiedWebhookEvent = {
      providerId: "stripe",
      type: "payment_intent.created",
      raw: { type: "payment_intent.created", data: { object: { id: "pi_test_123" } } },
    };
    await expect(stripeProvider.extractExpiration!(event)).resolves.toBeNull();
  });

  it("extracts the checkout session id from a checkout.session.expired event", async () => {
    const event: VerifiedWebhookEvent = {
      providerId: "stripe",
      type: "checkout.session.expired",
      raw: {
        type: "checkout.session.expired",
        data: { object: { id: "cs_test_abandoned_456" } },
      },
    };
    await expect(stripeProvider.extractExpiration!(event)).resolves.toEqual({
      providerTxnId: "cs_test_abandoned_456",
    });
  });
});
