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
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export function hashPassword(plain: string): string {
  if (!plain || plain.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(plain, salt, KEY_BYTES, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!plain || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const n = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(n) || n <= 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2], "base64");
    expected = Buffer.from(parts[3], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = scryptSync(plain, salt, expected.length, { N: n });
  // Both buffers are the same length by construction (we derived `actual` to
  // `expected.length`), so timingSafeEqual won't throw.
  return timingSafeEqual(actual, expected);
}
