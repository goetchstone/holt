// /app/src/lib/auth/password.ts
//
// Local-account password hashing for the credentials sign-in method. Uses
// Node's built-in scrypt (same primitive family as secretCrypto.ts) so no
// external hashing dependency is needed. Each hash carries its own random
// salt; verification is constant-time.
//
// Stored format (single string, safe to keep in StaffMember.passwordHash):
//
//   scrypt$<N>$<saltBase64>$<keyBase64>
//
// The bootstrap script scripts/create-admin.mjs reproduces this exact format
// inline; __tests__/password.test.ts pins it so the two can't drift.

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// scrypt cost parameter. 16384 (2^14) is Node's default and a sensible
// interactive-login cost. Stored in the hash so a future raise stays
// backward-compatible with already-stored hashes.
const SCRYPT_N = 16384;
// scrypt r (block size) and p (parallelization). These ARE Node's defaults, so
// pinning them changes no already-stored hash; it makes the cost explicit and
// immune to a future Node default change. r=8,p=1 with N=16384 needs ~16MB,
// under Node's 32MB scrypt maxmem.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// The weakest stored cost verify will honour. A hash below this -- a downgraded
// or corrupted row -- is refused, not silently accepted at a weak cost. It is a
// FIXED floor, not SCRYPT_N, so raising SCRYPT_N later still verifies the hashes
// already stored at 16384.
const SCRYPT_N_MIN = 16384;
// Minimum length for a NEW password. verify has no length gate, so raising this
// never locks out an existing account.
const MIN_PASSWORD_LENGTH = 12;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export function hashPassword(plain: string): string {
  if (!plain || plain.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(plain, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!plain || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const n = Number.parseInt(parts[1], 10);
  // Reject a stored cost weaker than the floor (a downgrade) instead of honouring
  // it. `n <= 1` was the old, near-useless check.
  if (!Number.isInteger(n) || n < SCRYPT_N_MIN) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2], "base64");
    expected = Buffer.from(parts[3], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r: SCRYPT_R, p: SCRYPT_P });
  } catch {
    // An absurd stored N throws on scrypt's memory cap; treat that as a failed
    // verification, never a thrown 500 on the login path.
    return false;
  }
  // Both buffers are the same length by construction (we derived `actual` to
  // `expected.length`), so timingSafeEqual won't throw.
  return timingSafeEqual(actual, expected);
}
