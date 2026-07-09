// /app/src/lib/stripe.ts

import Stripe from "stripe";
import { resolveCredential } from "@/lib/integrationCredentials";

// Cache the client AND the key it was built from. If the key changes (operator
// updates it in Settings), the cached client is rebuilt rather than serving the
// stale key.
let _stripe: { key: string; client: Stripe } | null = null;

/**
 * Resolve the Stripe client. The secret key is DB-first (Settings) with an
 * env fallback (STRIPE_SECRET_KEY), so a key configured in the admin UI takes
 * effect without a redeploy. Async because credential resolution hits the DB.
 */
export async function getStripe(): Promise<Stripe> {
  const key = await resolveCredential("stripe", "secretKey", "STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error(
      "Stripe is not configured: set the Stripe secret key in Settings > Integrations, " +
        "or the STRIPE_SECRET_KEY environment variable.",
    );
  }
  if (!_stripe || _stripe.key !== key) {
    _stripe = { key, client: new Stripe(key, { apiVersion: "2026-06-24.dahlia" }) };
  }
  return _stripe.client;
}

// Checkout links go to the real customer. STRIPE_TEST_EMAIL_OVERRIDE is an
// optional dev/testing escape hatch that redirects every link to one inbox so
// test charges never reach real customers; leave it unset in production.
export function resolveCheckoutEmail(customerEmail?: string | null): string | undefined {
  const override = process.env.STRIPE_TEST_EMAIL_OVERRIDE?.trim();
  return override || customerEmail || undefined;
}
