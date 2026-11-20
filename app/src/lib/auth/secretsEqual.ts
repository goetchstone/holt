// /app/src/lib/auth/secretsEqual.ts
//
// Compare a secret a request presented with the one the server holds, in
// constant time. `===` returns as soon as a character differs, so the time it
// takes says how much of a guess was right. Both sides are hashed first, so
// timingSafeEqual always compares two 32-byte digests: a different length
// neither throws nor tells the caller the secret's length.
//
// The one place request-supplied secrets are compared (rule 42): the scheduler's
// service key (lib/automations/guardAutomation.ts) and the bookings calendar
// feed token (pages/api/bookings/feed.ics.ts). Signed tokens that verify an HMAC
// (lib/booking/icsToken.ts) and password hashes (lib/auth/password.ts) compare
// their own digests with timingSafeEqual directly.

import { createHash, timingSafeEqual } from "crypto";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** True when `presented` equals `expected`, compared in constant time. An empty
 *  `expected` never matches: an unset secret fails closed (rule 63). */
export function secretsEqual(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}
