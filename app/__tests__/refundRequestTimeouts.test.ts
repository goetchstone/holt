// /app/__tests__/refundRequestTimeouts.test.ts
//
// A processor refund runs inside the transaction that holds the payment's refund lock
// (lib/paymentService.ts callProcessorAndSettle, five minutes), and the lock lasts only as long
// as that transaction. Each of the provider's requests is cut off well inside it, so the lock
// can't be freed while the processor is still paying the refund out: Stripe's SDK on its own
// tries a request three times at 80s each, and Square's fetch had no limit at all.

jest.mock("@/lib/stripe", () => ({ getStripe: jest.fn() }));
jest.mock("@/lib/square", () => ({ squareRequest: jest.fn(), getSquareCredentials: jest.fn() }));

import { getStripe } from "@/lib/stripe";
import { squareRequest } from "@/lib/square";
import { stripeProvider } from "@/lib/payments/stripeProvider";
import { squareProvider } from "@/lib/payments/squareProvider";
import { REFUND_REQUEST_TIMEOUT_MS } from "@/lib/payments/types";

const refund = { providerTxnId: "txn_1", amount: 12.5, idempotencyKey: "holt-refund-7" };

describe("a processor refund's requests", () => {
  it("Stripe: both carry the time limit and at most one retry, and the refund its key", async () => {
    const retrieve = jest.fn(async () => ({ payment_intent: "pi_1" }));
    const create = jest.fn(async () => ({ id: "re_1" }));
    jest
      .mocked(getStripe)
      .mockResolvedValue({ checkout: { sessions: { retrieve } }, refunds: { create } } as never);

    await expect(stripeProvider.refund!(refund)).resolves.toEqual({ refundId: "re_1" });

    const limit = { timeout: REFUND_REQUEST_TIMEOUT_MS, maxNetworkRetries: 1 };
    expect(retrieve).toHaveBeenCalledWith("txn_1", {}, limit);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_1" }), {
      ...limit,
      idempotencyKey: "holt-refund-7",
    });
  });

  it("Square: both carry the time limit", async () => {
    jest
      .mocked(squareRequest)
      .mockResolvedValueOnce({
        order: { tenders: [{ payment_id: "pay_1" }], total_money: { currency: "USD" } },
      })
      .mockResolvedValueOnce({ refund: { id: "sq_re_1" } });

    await expect(squareProvider.refund!(refund)).resolves.toEqual({ refundId: "sq_re_1" });

    const calls = jest.mocked(squareRequest).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, init] of calls) {
      expect(init).toEqual(expect.objectContaining({ timeoutMs: REFUND_REQUEST_TIMEOUT_MS }));
    }
  });

  it("stay well inside the five-minute lock, tried as often as they can be", () => {
    // Stripe: two requests, each tried twice. Square: two requests, each tried once.
    expect(2 * 2 * REFUND_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(2.5 * 60_000);
  });
});
