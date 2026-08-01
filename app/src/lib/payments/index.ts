// /app/src/lib/payments/index.ts
//
// Provider registry + resolution.
//
// Two DIFFERENT questions get asked of this module, and conflating them is the
// classic multi-processor bug:
//
//   1. "Which processor should take this NEW payment?"  -> getActiveProvider()
//      An operator choice. One active provider per organization.
//
//   2. "Which processor handled THIS EXISTING payment?" -> getProviderForPayment()
//      A historical fact, read off Payment.processorType. Refunds, webhooks and
//      status lookups MUST use this. If an org switches Stripe -> Square, every
//      previously captured Stripe payment still has to refund through Stripe;
//      routing those to the active provider would send a refund to a processor
//      that never took the money.
//
// The registry follows the house pattern used by integrationTest.ts — a small
// switch over a flat catalog — rather than a DI container, which nothing else
// in this codebase uses.

import { stripeProvider } from "@/lib/payments/stripeProvider";
import type {
  PaymentProvider,
  PaymentProviderId,
  ProviderCapabilities,
} from "@/lib/payments/types";

export * from "@/lib/payments/types";

const PROVIDERS: Record<PaymentProviderId, PaymentProvider | undefined> = {
  stripe: stripeProvider,
  // square: added by the Square integration.
  square: undefined,
};

/** True when the string names a processor this build knows about. */
export function isPaymentProviderId(value: string | null | undefined): value is PaymentProviderId {
  return value === "stripe" || value === "square";
}

/**
 * Look up a processor by id. Throws (rather than returning undefined) because
 * every caller needs a provider to continue, and an operator-readable message
 * beats a null-deref three frames later.
 */
export function getPaymentProvider(id: PaymentProviderId): PaymentProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Payment provider "${id}" is not available in this build. ` +
        `Configure a supported provider in Settings > Integrations.`,
    );
  }
  return provider;
}

/**
 * The processor that should take NEW payments for this deployment.
 *
 * Resolution order: PAYMENT_PROVIDER env override, then Stripe. Stripe is the
 * default so this refactor is behaviour-preserving — every existing install
 * keeps working with no configuration change. The admin-facing per-org setting
 * lands with the second provider, when there is actually a choice to offer.
 */
export function getActiveProviderId(): PaymentProviderId {
  const configured = process.env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (isPaymentProviderId(configured)) return configured;
  return "stripe";
}

export function getActiveProvider(): PaymentProvider {
  return getPaymentProvider(getActiveProviderId());
}

/**
 * The processor that handled an existing payment. Pass `Payment.processorType`.
 *
 * Legacy rows predate multi-provider and may carry a null/unrecognised value;
 * those are treated as Stripe, which is what they are in every existing
 * install. An unrecognised NON-null value throws rather than silently guessing
 * — refunding through the wrong processor is worse than a clear failure.
 */
export function getProviderForPayment(processorType: string | null | undefined): PaymentProvider {
  if (!processorType) return getPaymentProvider("stripe");
  const normalized = processorType.trim().toLowerCase();
  if (!isPaymentProviderId(normalized)) {
    throw new Error(
      `Payment was processed by "${processorType}", which this build cannot service. ` +
        `Refunds and status lookups for it must be handled in that processor's own dashboard.`,
    );
  }
  return getPaymentProvider(normalized);
}

/**
 * Guard an optional capability before dispatching to it, so an unsupported
 * combination fails with an explanation instead of "x is not a function".
 */
export function assertCapability(
  provider: PaymentProvider,
  capability: keyof ProviderCapabilities,
): void {
  if (!provider.capabilities[capability]) {
    throw new Error(
      `${provider.displayName} does not support ${capability} in Holt. ` +
        `Choose a provider that does, or use a different payment method.`,
    );
  }
}

/** Providers compiled into this build, for admin UI / diagnostics. */
export function listAvailableProviders(): PaymentProvider[] {
  return Object.values(PROVIDERS).filter((p): p is PaymentProvider => Boolean(p));
}
