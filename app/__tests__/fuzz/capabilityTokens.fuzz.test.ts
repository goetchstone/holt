// /app/__tests__/fuzz/capabilityTokens.fuzz.test.ts
//
// Property-based fuzzing of the unauthenticated capability checks: the booking
// calendar HMAC (lib/booking/icsToken.ts, read off ?token= on a public route)
// and the order / client portal JWTs (lib/capabilityToken.ts). The token is the
// only credential these links carry, so the verifiers must (a) never throw on
// whatever a stranger types into the URL and (b) accept nothing but the exact
// token minted for that id and that family.
//
// Found a real bug on its first run: verifyBookingToken compared UTF-16 string
// lengths, then handed UTF-8 Buffers to timingSafeEqual, so any 32-character
// token with a non-ASCII character threw a RangeError (a 500 on a public
// route). Counterexample: verifyBookingToken(1, "é".repeat(32)).

import fc from "fast-check";
import { signBookingId, verifyBookingToken } from "@/lib/booking/icsToken";
import { generatePortalToken, verifyPortalToken } from "@/lib/portalToken";
import { generateClientPortalToken, verifyClientPortalToken } from "@/lib/clientPortalToken";
import { anyString, nastyString } from "./support";

const ORIGINAL_SECRET = process.env.NEXTAUTH_SECRET;
beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "fuzz-secret-capability-tokens";
});
afterAll(() => {
  process.env.NEXTAUTH_SECRET = ORIGINAL_SECRET;
});

const bookingId = fc.integer({ min: 1, max: 2 ** 31 - 1 });
// The booking token is 32 hex chars, so 32-unit strings are the interesting
// length: they get past a length check and reach the constant-time compare.
const tokenLike = fc.oneof(
  anyString(64),
  fc.string({ unit: "binary", minLength: 32, maxLength: 32 }),
  fc.string({ unit: "binary-ascii", minLength: 32, maxLength: 32 }),
  nastyString(),
);

describe("booking calendar token (lib/booking/icsToken.ts)", () => {
  it("never throws, and accepts only the exact token for that id", () => {
    fc.assert(
      fc.property(bookingId, fc.option(tokenLike, { nil: undefined }), (id, token) => {
        expect(verifyBookingToken(id, token)).toBe(token === signBookingId(id));
      }),
    );
  });

  it("rejects every single-character change to a valid token", () => {
    fc.assert(
      fc.property(
        bookingId,
        fc.nat(),
        fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
        (id, pos, ch) => {
          const valid = signBookingId(id);
          const i = pos % valid.length;
          fc.pre(valid[i] !== ch);
          const mutated = valid.slice(0, i) + ch + valid.slice(i + 1);
          expect(verifyBookingToken(id, mutated)).toBe(false);
        },
      ),
    );
  });

  it("never accepts one booking's token for another booking", () => {
    fc.assert(
      fc.property(bookingId, bookingId, (a, b) => {
        fc.pre(a !== b);
        expect(verifyBookingToken(a, signBookingId(b))).toBe(false);
      }),
    );
  });
});

// Three base64url segments, so the junk gets past "is this a JWT at all" and
// into header/claim decoding, including an alg:none header.
const b64url = (s: string): string => Buffer.from(s).toString("base64url");
const jwtShaped = fc
  .tuple(
    fc.oneof(
      fc.constant(b64url('{"alg":"none","typ":"JWT"}')),
      fc.constant(b64url('{"alg":"HS256","typ":"JWT"}')),
      fc.constant(b64url('{"alg":"RS256","typ":"JWT"}')),
      anyString(40).map(b64url),
    ),
    fc
      .oneof(
        fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.stringify(v)),
        fc.constant('{"orderId":1,"customerId":1,"aud":"holt-portal","iss":"holt"}'),
        anyString(40),
      )
      .map(b64url),
    fc.oneof(fc.constant(""), anyString(60).map(b64url)),
  )
  .map((parts) => parts.join("."));

describe("portal capability tokens (lib/capabilityToken.ts)", () => {
  it("never throws and accepts nothing it did not sign", () => {
    fc.assert(
      fc.property(fc.oneof(tokenLike, jwtShaped), (token) => {
        expect(verifyPortalToken(token)).toBeNull();
        expect(verifyClientPortalToken(token)).toBeNull();
      }),
    );
  });

  it("round-trips its own claims and rejects every single-character change", () => {
    const id = fc.integer({ min: 1, max: 2 ** 31 - 1 });
    fc.assert(
      fc.property(
        id,
        id,
        fc.nat(),
        fc.constantFrom(..."ABCabc012-_.~=é"),
        (orderId, customerId, pos, ch) => {
          const token = generatePortalToken(orderId, customerId);
          expect(verifyPortalToken(token)).toEqual({ orderId, customerId });
          const i = pos % token.length;
          fc.pre(token[i] !== ch);
          const mutated = token.slice(0, i) + ch + token.slice(i + 1);
          expect(verifyPortalToken(mutated)).toBeNull();
        },
      ),
    );
  });

  it("never accepts one family's token as the other's", () => {
    const id = fc.integer({ min: 1, max: 2 ** 31 - 1 });
    fc.assert(
      fc.property(id, id, (orderId, customerId) => {
        expect(verifyClientPortalToken(generatePortalToken(orderId, customerId))).toBeNull();
        expect(verifyPortalToken(generateClientPortalToken(customerId))).toBeNull();
      }),
    );
  });
});
