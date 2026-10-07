// /app/src/lib/booking/icsToken.ts
//
// The public booking calendar download (/api/bookings/[id]/ics) is unauthenticated
// by design -- the customer who just booked has no login. But the booking id is a
// sequential integer, so the id alone can't be the capability: anyone could iterate
// 1..N and harvest every customer's name/email/notes. We gate the download on an
// HMAC of the id instead. The token is handed back only in the create response and
// is unguessable without NEXTAUTH_SECRET, which never leaves the server.

import { createHmac, timingSafeEqual } from "crypto";

function signingSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.APP_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required to sign booking calendar links");
  }
  return secret;
}

export function signBookingId(id: number): string {
  return createHmac("sha256", signingSecret()).update(`booking:${id}`).digest("hex").slice(0, 32);
}

export function verifyBookingToken(id: number, token: string | undefined): boolean {
  if (!token) return false;
  const expected = signBookingId(id);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
