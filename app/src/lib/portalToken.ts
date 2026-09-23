// /app/src/lib/portalToken.ts
//
// Order-scoped capability link: lets a customer view and pay one order without
// an account. Signing, key separation and verification are shared with the
// client portal in lib/capabilityToken.ts — this file only names the family and
// its claims.

import { signCapabilityToken, verifyCapabilityToken } from "@/lib/capabilityToken";

const AUDIENCE = "holt-portal";

/**
 * Lifetime when the deployment has not set AppSettings.portalTokenTtlHours.
 * These links are not revocable, so they expire quickly (it was 7 days).
 */
export const DEFAULT_PORTAL_TOKEN_TTL_HOURS = 48;

interface PortalTokenPayload {
  orderId: number;
  customerId: number;
}

export function generatePortalToken(
  orderId: number,
  customerId: number,
  ttlHours: number = DEFAULT_PORTAL_TOKEN_TTL_HOURS,
): string {
  return signCapabilityToken({ orderId, customerId }, AUDIENCE, ttlHours * 60 * 60);
}

export function verifyPortalToken(token: string): PortalTokenPayload | null {
  const decoded = verifyCapabilityToken(token, AUDIENCE);
  if (!decoded || typeof decoded.orderId !== "number" || typeof decoded.customerId !== "number") {
    return null;
  }
  return { orderId: decoded.orderId, customerId: decoded.customerId };
}
