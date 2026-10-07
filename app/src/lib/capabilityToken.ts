// /app/src/lib/capabilityToken.ts
//
// Signed, stateless capability links — the order portal (lib/portalToken.ts)
// and the client portal (lib/clientPortalToken.ts). The token is the ONLY
// credential such a link carries, so every family is pinned the same way, in
// this one place (CLAUDE.md principle 3: a guard on one path is no guard):
//
//  - its own key, derived from NEXTAUTH_SECRET with HKDF using the family's
//    audience as the context label (RFC 5869 `info`). A token can therefore never
//    be replayed as a session JWT, nor as another family's token — the keys differ,
//    not merely a claim;
//  - HS256 only: `algorithms` is pinned on verify, so a token with `alg: none` or
//    an asymmetric header cannot slip past;
//  - an audience and an issuer, rejecting a JWT minted for any other purpose.
//
// Links are not revocable (no DB row), so revocation is by expiry — callers pass
// a short TTL.

import jwt, { type JwtPayload } from "jsonwebtoken";
import { hkdfSync } from "crypto";

const ISSUER = "holt";

function familyKey(audience: string): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not configured");
  }
  return Buffer.from(hkdfSync("sha256", secret, "", audience, 32));
}

export function signCapabilityToken(
  payload: Record<string, unknown>,
  audience: string,
  ttlSeconds: number,
): string {
  return jwt.sign(payload, familyKey(audience), {
    algorithm: "HS256",
    audience,
    issuer: ISSUER,
    expiresIn: ttlSeconds,
  });
}

/** The verified claims, or null for anything expired, forged, mis-addressed or malformed. */
export function verifyCapabilityToken(token: string, audience: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, familyKey(audience), {
      algorithms: ["HS256"],
      audience,
      issuer: ISSUER,
    });
    return typeof decoded === "object" ? decoded : null;
  } catch {
    return null;
  }
}
