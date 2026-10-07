// /app/__tests__/squareProvider.test.ts
//
// Behavioural coverage for squareProvider.ts. No network: verifyWebhook and
// extractCompletion's early-return path are pure given their inputs, and
// toMinorUnits / mapOrderStateToStatus are exported specifically so the
// conversion and mapping logic is testable without a live Square call
// (CLAUDE.md rule 14 -- test the logic, not the wrapper).
//
// The webhook signature tests build their own HMAC using the same recipe
// Square documents (HMAC-SHA256 of notificationUrl + rawBody, base64), so
// this is a real assertion against squareProvider's implementation, not a
// mock of it.

import { createHmac } from "crypto";
import { squareProvider, toMinorUnits, mapOrderStateToStatus } from "@/lib/payments/squareProvider";
import type { VerifiedWebhookEvent } from "@/lib/payments/types";

const SECRET = "test-square-signature-key";
const NOTIFICATION_URL = "https://holt.example.com/api/square/webhook";

function sign(url: string, body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret)
    .update(url + body)
    .digest("base64");
}

describe("toMinorUnits", () => {
  it("converts dollars to cents", () => {
    expect(toMinorUnits(10)).toBe(1000);
    expect(toMinorUnits(19.99)).toBe(1999);
  });

  it("rounds to the nearest cent (floating point safety)", () => {
    expect(toMinorUnits(19.999)).toBe(2000);
    expect(toMinorUnits(0.1 + 0.2)).toBe(30); // 0.30000000000000004 -> 30 cents
  });

  it("handles zero", () => {
    expect(toMinorUnits(0)).toBe(0);
  });
});

describe("mapOrderStateToStatus", () => {
  it("maps COMPLETED to complete", () => {
    expect(mapOrderStateToStatus("COMPLETED")).toBe("complete");
  });

  it("maps CANCELED to expired", () => {
    expect(mapOrderStateToStatus("CANCELED")).toBe("expired");
  });

  it("maps OPEN to open", () => {
    expect(mapOrderStateToStatus("OPEN")).toBe("open");
  });

  it("maps DRAFT and any unrecognised/undefined state to open, never throwing", () => {
    expect(mapOrderStateToStatus("DRAFT")).toBe("open");
    expect(mapOrderStateToStatus(undefined)).toBe("open");
    expect(mapOrderStateToStatus("SOMETHING_NEW_SQUARE_ADDS_LATER")).toBe("open");
  });
});

describe("squareProvider capabilities", () => {
  it("declares hostedCheckout + refunds, and honestly declares terminal unsupported for this PR", () => {
    expect(squareProvider.capabilities).toEqual({
      hostedCheckout: true,
      terminal: false,
      refunds: true,
    });
  });
});

describe("squareProvider.verifyWebhook", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "payment.updated", data: { id: "abc" } }));

  it("accepts a correctly-signed payload", async () => {
    const signature = sign(NOTIFICATION_URL, rawBody.toString("utf8"));
    const event = await squareProvider.verifyWebhook!({
      rawBody,
      headers: { "x-square-hmacsha256-signature": signature },
      secret: SECRET,
      requestUrl: NOTIFICATION_URL,
    });
    expect(event.providerId).toBe("square");
    expect(event.type).toBe("payment.updated");
  });

  it("rejects a tampered body (signature computed over the original body)", async () => {
    const signature = sign(NOTIFICATION_URL, rawBody.toString("utf8"));
    const tamperedBody = Buffer.from(
      JSON.stringify({ type: "payment.updated", data: { id: "TAMPERED" } }),
    );
    await expect(
      squareProvider.verifyWebhook!({
        rawBody: tamperedBody,
        headers: { "x-square-hmacsha256-signature": signature },
        secret: SECRET,
        requestUrl: NOTIFICATION_URL,
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it("rejects a wrong signature (correct body, signed with a different key)", async () => {
    const wrongSignature = sign(NOTIFICATION_URL, rawBody.toString("utf8"), "a-different-key");
    await expect(
      squareProvider.verifyWebhook!({
        rawBody,
        headers: { "x-square-hmacsha256-signature": wrongSignature },
        secret: SECRET,
        requestUrl: NOTIFICATION_URL,
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it("rejects a missing signature header", async () => {
    await expect(
      squareProvider.verifyWebhook!({
        rawBody,
        headers: {},
        secret: SECRET,
        requestUrl: NOTIFICATION_URL,
      }),
    ).rejects.toThrow(/missing x-square-hmacsha256-signature header/i);
  });

  it("rejects when the notification URL is missing (Square signs the URL, not just the body)", async () => {
    const signature = sign(NOTIFICATION_URL, rawBody.toString("utf8"));
    await expect(
      squareProvider.verifyWebhook!({
        rawBody,
        headers: { "x-square-hmacsha256-signature": signature },
        secret: SECRET,
      }),
    ).rejects.toThrow(/requires the notification url/i);
  });

  it("signature check is truly URL-bound: the same body signed against a different URL fails here", async () => {
    const signature = sign(
      "https://someone-elses-app.example.com/webhook",
      rawBody.toString("utf8"),
    );
    await expect(
      squareProvider.verifyWebhook!({
        rawBody,
        headers: { "x-square-hmacsha256-signature": signature },
        secret: SECRET,
        requestUrl: NOTIFICATION_URL,
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });
});

describe("squareProvider.extractCompletion", () => {
  it("returns null for a non-completion event type, with no network call", async () => {
    const event: VerifiedWebhookEvent = {
      providerId: "square",
      type: "refund.created",
      raw: { type: "refund.created", data: {} },
    };
    await expect(squareProvider.extractCompletion!(event)).resolves.toBeNull();
  });

  it("returns null for a payment event whose payment is not yet COMPLETED, with no network call", async () => {
    const event: VerifiedWebhookEvent = {
      providerId: "square",
      type: "payment.created",
      raw: {
        type: "payment.created",
        data: { object: { payment: { id: "pay_1", order_id: "order_1", status: "PENDING" } } },
      },
    };
    await expect(squareProvider.extractCompletion!(event)).resolves.toBeNull();
  });

  it("returns null when the event carries no payment object at all", async () => {
    const event: VerifiedWebhookEvent = {
      providerId: "square",
      type: "payment.updated",
      raw: { type: "payment.updated", data: {} },
    };
    await expect(squareProvider.extractCompletion!(event)).resolves.toBeNull();
  });
});
