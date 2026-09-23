/**
 * SEC-08 — capability links (order portal, client portal) are pinned in one
 * shared helper (lib/capabilityToken.ts): a per-family key derived from
 * NEXTAUTH_SECRET with HKDF, HS256 only, and an audience + issuer.
 *
 * Fails against the old code, where both families signed with the raw session
 * secret, verified with no algorithm pin and no audience, and order links lived
 * 7 days: a token signed with the raw session secret verified (both families),
 * an order link was still valid at 49 hours, and a configured TTL was ignored.
 */
import jwt from "jsonwebtoken";
import { hkdfSync } from "crypto";
import { generatePortalToken, verifyPortalToken } from "@/lib/portalToken";
import { generateClientPortalToken, verifyClientPortalToken } from "@/lib/clientPortalToken";

const SECRET = "test-secret-for-capability-tokens";

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
});

// The per-family key, derived exactly as capabilityToken.ts derives it, so a
// test can mint a token that is correctly signed but wrong in one other respect.
const familyKey = (audience: string) => Buffer.from(hkdfSync("sha256", SECRET, "", audience, 32));

// A hand-built `alg: none` token -- header, claims, empty signature -- so the
// test does not depend on whether the JWT library is willing to produce one.
function unsignedToken(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
}

describe("order-portal token", () => {
  it("round-trips its claims", () => {
    expect(verifyPortalToken(generatePortalToken(7, 42))).toEqual({ orderId: 7, customerId: 42 });
  });

  it("rejects a token signed with the raw session secret (the pre-SEC-08 scheme)", () => {
    // Every portal link used to be exactly this. The session secret must not
    // verify a portal link -- that is the key separation HKDF buys.
    const legacy = jwt.sign({ orderId: 7, customerId: 42 }, SECRET, { expiresIn: "7d" });
    expect(verifyPortalToken(legacy)).toBeNull();
  });

  it("rejects an alg:none token", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = unsignedToken({
      orderId: 7,
      customerId: 42,
      aud: "holt-portal",
      iss: "holt",
      exp,
    });
    expect(verifyPortalToken(token)).toBeNull();
  });

  it("rejects a correctly keyed token addressed to another audience", () => {
    const token = jwt.sign({ orderId: 7, customerId: 42 }, familyKey("holt-portal"), {
      algorithm: "HS256",
      audience: "someone-else",
      issuer: "holt",
    });
    expect(verifyPortalToken(token)).toBeNull();
  });

  it("rejects a correctly keyed token from another issuer", () => {
    const token = jwt.sign({ orderId: 7, customerId: 42 }, familyKey("holt-portal"), {
      algorithm: "HS256",
      audience: "holt-portal",
      issuer: "not-holt",
    });
    expect(verifyPortalToken(token)).toBeNull();
  });

  describe("lifetime", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("defaults to 48 hours: valid at 47h, expired at 49h", () => {
      jest.setSystemTime(new Date("2026-09-23T00:00:00Z"));
      const token = generatePortalToken(7, 42);
      jest.setSystemTime(new Date("2026-09-24T23:00:00Z")); // +47h
      expect(verifyPortalToken(token)).not.toBeNull();
      jest.setSystemTime(new Date("2026-09-25T01:00:00Z")); // +49h
      expect(verifyPortalToken(token)).toBeNull();
    });

    it("honours a configured lifetime", () => {
      jest.setSystemTime(new Date("2026-09-23T00:00:00Z"));
      const token = generatePortalToken(7, 42, 2);
      jest.setSystemTime(new Date("2026-09-23T01:00:00Z")); // +1h
      expect(verifyPortalToken(token)).not.toBeNull();
      jest.setSystemTime(new Date("2026-09-23T03:00:00Z")); // +3h
      expect(verifyPortalToken(token)).toBeNull();
    });
  });
});

describe("family isolation", () => {
  it("an order-portal token does not open the client portal", () => {
    expect(verifyClientPortalToken(generatePortalToken(7, 42))).toBeNull();
  });

  it("a client-portal token does not open an order", () => {
    expect(verifyPortalToken(generateClientPortalToken(42))).toBeNull();
  });

  it("the client portal also rejects a token signed with the raw session secret", () => {
    const legacy = jwt.sign({ customerId: 42, scope: "client-portal" }, SECRET, {
      expiresIn: "30d",
    });
    expect(verifyClientPortalToken(legacy)).toBeNull();
  });

  it("the client-portal token round-trips", () => {
    expect(verifyClientPortalToken(generateClientPortalToken(42))).toEqual({ customerId: 42 });
  });
});
