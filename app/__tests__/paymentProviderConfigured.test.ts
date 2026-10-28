// /app/__tests__/paymentProviderConfigured.test.ts
//
// PaymentProvider.isConfigured -- what the getting-started checklist means by
// "a card processor is configured". It goes through the same resolver that
// taking a payment does (getStripe / getSquareCredentials), so only the
// credential lookup is replaced here: Settings-or-env resolution itself is
// resolveCredential's job. No network: neither check makes a request.

const mockResolveCredential = jest.fn<
  Promise<string | undefined>,
  [provider: string, field: string, envVar: string]
>();

jest.mock("@/lib/integrationCredentials", () => ({
  resolveCredential: (provider: string, field: string, envVar: string) =>
    mockResolveCredential(provider, field, envVar),
}));

import { stripeProvider } from "@/lib/payments/stripeProvider";
import { squareProvider } from "@/lib/payments/squareProvider";

/** Resolve exactly these provider.field credentials; everything else is unset. */
function credentials(set: Record<string, string>) {
  mockResolveCredential.mockImplementation(async (provider, field) => set[`${provider}.${field}`]);
}

beforeEach(() => mockResolveCredential.mockReset());

describe("stripeProvider.isConfigured", () => {
  it("is true when the secret key resolves", async () => {
    credentials({ "stripe.secretKey": "sk_test_123" });
    await expect(stripeProvider.isConfigured()).resolves.toBe(true);
    expect(mockResolveCredential).toHaveBeenCalledWith("stripe", "secretKey", "STRIPE_SECRET_KEY");
  });

  it("is false when it does not -- a publishable key alone takes no payment", async () => {
    credentials({ "stripe.publishableKey": "pk_test_123" });
    await expect(stripeProvider.isConfigured()).resolves.toBe(false);
  });
});

describe("squareProvider.isConfigured", () => {
  it("is true when both the access token and the location id resolve", async () => {
    credentials({ "square.accessToken": "EAAA-token", "square.locationId": "L1" });
    await expect(squareProvider.isConfigured()).resolves.toBe(true);
  });

  it("is false with the access token but no location id", async () => {
    credentials({ "square.accessToken": "EAAA-token" });
    await expect(squareProvider.isConfigured()).resolves.toBe(false);
  });

  it("is false with nothing set", async () => {
    credentials({});
    await expect(squareProvider.isConfigured()).resolves.toBe(false);
  });
});
