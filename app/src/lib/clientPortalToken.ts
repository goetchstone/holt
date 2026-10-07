// /app/src/lib/clientPortalToken.ts
//
// Customer-scoped capability token for the consultancy client portal (feature
// flag `clientPortal`). Same stateless-JWT pattern as the order-scoped
// lib/portalToken.ts, and signed by the same shared helper
// (lib/capabilityToken.ts): links need no DB row, and revocation is by expiry.
//
// Isolation from the order portal is by audience — and because the audience is
// also the HKDF label, the two families are signed with DIFFERENT keys, so an
// order-portal token cannot open the client hub or vice versa. (This replaces a
// `scope` claim that shared one key with the order portal and the session.)

import { signCapabilityToken, verifyCapabilityToken } from "@/lib/capabilityToken";

const AUDIENCE = "holt-client-portal";
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function generateClientPortalToken(customerId: number): string {
  return signCapabilityToken({ customerId }, AUDIENCE, TTL_SECONDS);
}

export function verifyClientPortalToken(token: string): { customerId: number } | null {
  const decoded = verifyCapabilityToken(token, AUDIENCE);
  if (!decoded || typeof decoded.customerId !== "number") {
    return null;
  }
  return { customerId: decoded.customerId };
}
