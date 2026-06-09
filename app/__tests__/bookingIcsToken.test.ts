// /app/__tests__/bookingIcsToken.test.ts

import { signBookingId, verifyBookingToken } from "@/lib/booking/icsToken";

describe("booking ics token", () => {
  const ORIGINAL = process.env.NEXTAUTH_SECRET;
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-for-booking-ics";
  });
  afterAll(() => {
    process.env.NEXTAUTH_SECRET = ORIGINAL;
  });

  it("is deterministic for the same id", () => {
    expect(signBookingId(42)).toBe(signBookingId(42));
  });

  it("produces different tokens for different ids", () => {
    expect(signBookingId(1)).not.toBe(signBookingId(2));
  });

  it("accepts the matching token", () => {
    expect(verifyBookingToken(7, signBookingId(7))).toBe(true);
  });

  it("rejects a token issued for a different id (no enumeration)", () => {
    expect(verifyBookingToken(8, signBookingId(9))).toBe(false);
  });

  it("rejects a missing or empty token", () => {
    expect(verifyBookingToken(5, undefined)).toBe(false);
    expect(verifyBookingToken(5, "")).toBe(false);
  });

  it("rejects a wrong-length token without throwing", () => {
    expect(verifyBookingToken(5, "deadbeef")).toBe(false);
  });
});
