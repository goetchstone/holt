// /app/src/lib/portalLink.ts
//
// A customer's link to one order in the portal (/portal/order), signed for the
// store's link lifetime (AppSettings.portalTokenTtlHours, Settings). Staff copy
// one from the order page (api/portal/generate-link); each automatic customer
// message carries a fresh one (lib/messages/due.ts).

import { generatePortalToken } from "@/lib/portalToken";

export function portalOrderUrl(
  orderId: number,
  customerId: number,
  ttlHours: number | null,
): string {
  // The link is non-revocable, so its lifetime is the deployment's choice;
  // unset (null) falls back to generatePortalToken's 48-hour default.
  const token = generatePortalToken(orderId, customerId, ttlHours ?? undefined);
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  return `${baseUrl}/portal/order?token=${token}`;
}
