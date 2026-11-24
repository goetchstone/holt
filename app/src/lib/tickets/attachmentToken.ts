// /app/src/lib/tickets/attachmentToken.ts
//
// The customer's link to one file on their ticket (SEC-04b). The public status
// page (/support/[token]) lists each attachment with a link to
// /api/tickets/public/files/[token], minted here every time the page loads.
// Ticket files are no longer public under /uploads/attachments: staff read them
// on "View service", customers through these links.
//
// Same stateless capability as the order and client portals, signed by the
// shared helper (lib/capabilityToken.ts): scope is one attachment, expiry is
// the JWT's exp, and the audience is also the HKDF label, so this family is
// signed with its own key -- neither portal's token opens a file, and a file
// token opens neither portal.

import { signCapabilityToken, verifyCapabilityToken } from "@/lib/capabilityToken";

const AUDIENCE = "holt-ticket-attachment";

/**
 * One hour. A link is minted on every load of the status page, so it only has
 * to outlive one visit; a page left open longer shows the reload message when
 * a file is clicked.
 */
export const TICKET_ATTACHMENT_LINK_TTL_SECONDS = 60 * 60;

export function generateTicketAttachmentToken(attachmentId: number): string {
  return signCapabilityToken({ attachmentId }, AUDIENCE, TICKET_ATTACHMENT_LINK_TTL_SECONDS);
}

/** The attachment a token opens, or null for anything expired, forged, mis-addressed or malformed. */
export function verifyTicketAttachmentToken(token: string): { attachmentId: number } | null {
  const decoded = verifyCapabilityToken(token, AUDIENCE);
  if (!decoded || !Number.isInteger(decoded.attachmentId)) return null;
  return { attachmentId: decoded.attachmentId as number };
}

/** The customer's link to one attachment: relative, because the status page is on the same origin. */
export function publicTicketAttachmentUrl(attachmentId: number): string {
  return `/api/tickets/public/files/${generateTicketAttachmentToken(attachmentId)}`;
}
