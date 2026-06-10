// /app/__tests__/clientPortalToken.test.ts
//
// Pure tests for the client-portal capability token: round-trip, scope
// isolation from the order-portal token, and rejection of garbage/tampered
// values. The scope check is the load-bearing assertion — an order token
// must never open the client hub.

import { generateClientPortalToken, verifyClientPortalToken } from "@/lib/clientPortalToken";
import { generatePortalToken } from "@/lib/portalToken";

describe("clientPortalToken", () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "test-secret";
  });

  it("round-trips the customerId", () => {
    const token = generateClientPortalToken(42);
    expect(verifyClientPortalToken(token)).toEqual({ customerId: 42 });
  });

  it("rejects an ORDER-portal token (scope isolation)", () => {
    const orderToken = generatePortalToken(7, 42);
    expect(verifyClientPortalToken(orderToken)).toBeNull();
  });

  it("rejects garbage and tampered tokens", () => {
    expect(verifyClientPortalToken("not-a-token")).toBeNull();
    const token = generateClientPortalToken(42);
    const tampered = token.slice(0, -4) + "AAAA";
    expect(verifyClientPortalToken(tampered)).toBeNull();
  });
});
