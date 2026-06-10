// /app/src/lib/clientPortalToken.ts
//
// Customer-scoped capability token for the consultancy client portal
// (feature flag `clientPortal`). Same stateless-JWT pattern as the
// order-scoped lib/portalToken.ts: signed with NEXTAUTH_SECRET, so links
// need no DB row and revocation is by expiry. The `scope` claim prevents an
// order-portal token from opening the client hub and vice versa.

import jwt from "jsonwebtoken";

const SCOPE = "client-portal";
const EXPIRY = "30d";

interface ClientPortalTokenPayload {
  customerId: number;
  scope: typeof SCOPE;
}

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not configured");
  }
  return secret;
}

export function generateClientPortalToken(customerId: number): string {
  return jwt.sign({ customerId, scope: SCOPE }, getSecret(), { expiresIn: EXPIRY });
}

export function verifyClientPortalToken(token: string): { customerId: number } | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as Partial<ClientPortalTokenPayload>;
    if (typeof decoded.customerId !== "number" || decoded.scope !== SCOPE) {
      return null;
    }
    return { customerId: decoded.customerId };
  } catch {
    return null;
  }
}
