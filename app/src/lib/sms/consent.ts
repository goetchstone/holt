// /app/src/lib/sms/consent.ts
//
// Who may get a text (GAP-12), in one place (rule 42): the automatic messages
// and staff's "Text the link" both ask here. Holt texts a customer only with a
// number it can text, their consent on record, and no STOP from that number.
// Strict on purpose: a text without consent is a legal exposure for the store,
// and a phone number on a customer record isn't consent.

import type { Prisma } from "@prisma/client";
import { toE164 } from "./phone";

type Db = Pick<Prisma.TransactionClient, "smsOptOut">;

export const NO_TEXTABLE_NUMBER = "The customer has no number that can take a text.";
export const NO_TEXT_CONSENT = "The customer hasn't agreed to texts.";
export const REPLIED_STOP = "This number replied STOP.";

export async function isSmsOptedOut(db: Db, phone: string): Promise<boolean> {
  return (await db.smsOptOut.count({ where: { phone } })) > 0;
}

/** The number to text this customer at, or why not. */
export async function textableNumber(
  db: Db,
  customer: { phone: string | null; smsConsentAt: Date | null },
  locale: string,
): Promise<{ phone: string } | { problem: string }> {
  const phone = toE164(customer.phone, locale);
  if (!phone) return { problem: NO_TEXTABLE_NUMBER };
  if (!customer.smsConsentAt) return { problem: NO_TEXT_CONSENT };
  if (await isSmsOptedOut(db, phone)) return { problem: REPLIED_STOP };
  return { phone };
}
