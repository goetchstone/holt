// /app/src/lib/tickets/token.ts
//
// Stable random token for the no-login public ticket view (/support/[token]).
// Unguessable (192 bits) and URL-safe. Distinct from the signed, expiring JWT
// portalToken used for order access -- a ticket token is a permanent handle
// stored on the row.

import { randomBytes } from "node:crypto";

export function generateTicketToken(): string {
  return randomBytes(24).toString("base64url");
}
