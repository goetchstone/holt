// /app/src/lib/auth/secretsEqual.ts
//
// Compare a secret a request presented with the one the server holds, in
// constant time. `===` returns as soon as a character differs, so the time it
// takes says how much of a guess was right.
//
// The comparison always runs over the EXPECTED secret's length: the presented
// value is copied into a buffer of that size (cut short or zero-padded) and
// compared with timingSafeEqual, and the lengths must also match. So the time
// depends only on the expected secret, never on how much of a guess was right
// or how long the guess was. Nothing is hashed: a fast hash of a secret reads,
// to a scanner and to a reader, like a weakly stored password (CodeQL
// js/insufficient-password-hash flagged an earlier SHA-256 version of this file
// on 2026-11-20), and nothing here is stored.
//
// The one place request-supplied secrets are compared (rule 42): the scheduler's
// service key (lib/automations/guardAutomation.ts) and the bookings calendar
// feed token (pages/api/bookings/feed.ics.ts). Signed tokens that verify an HMAC
// (lib/booking/icsToken.ts) and password hashes (lib/auth/password.ts) compare
// their own digests with timingSafeEqual directly.

import { timingSafeEqual } from "crypto";

/** True when `presented` equals `expected`, compared in constant time. An empty
 *  `expected` never matches: an unset secret fails closed (rule 63). */
export function secretsEqual(presented: string, expected: string): boolean {
  const want = Buffer.from(expected, "utf8");
  if (want.length === 0) return false;
  const got = Buffer.from(presented, "utf8");
  const sameSize = Buffer.alloc(want.length);
  got.copy(sameSize, 0, 0, want.length);
  // The compare always runs in full; only then does the length decide.
  const bytesMatch = timingSafeEqual(sameSize, want);
  return bytesMatch && got.length === want.length;
}
