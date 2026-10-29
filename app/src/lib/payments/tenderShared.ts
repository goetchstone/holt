// /app/src/lib/payments/tenderShared.ts
//
// Client-safe contract for the tenders a store sets up for itself (rule 7):
// the Settings screen, the register and the invoice screen import it, and so
// does lib/payments/tenders.ts, which enforces it. No Prisma or server imports.
//
// A store tender is a NAME the store chooses (each finance company, Zelle, a
// trade-in) on top of a built-in KIND that decides how it behaves and where it
// reports (rule 62). The kinds with machinery of their own -- cash in the
// drawer, a card processor, a gift card's balance, a customer's credit -- stay
// built-in, so a store tender is one of the kinds that are only recorded.

import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { DEPOSIT_OFFSET_LABELS } from "@/lib/glMapping";

export const TENDER_KINDS = ["FINANCE", "WIRE", "ACH", "OTHER"] as const;
export type TenderKind = (typeof TENDER_KINDS)[number];

export const TENDER_NAME_MAX = 60;
/** The longest reference a payment keeps; the invoice form has the same cap. */
export const REFERENCE_MAX = 100;

/** A store tender as the register and the invoice screen offer it. */
export interface OfferedTender {
  id: number;
  name: string;
  kind: TenderKind;
  referenceRequired: boolean;
}

export function isTenderKind(value: unknown): value is TenderKind {
  return typeof value === "string" && (TENDER_KINDS as readonly string[]).includes(value);
}

/**
 * Why `name` cannot name a store tender, or null when it can.
 *
 * A payment's name is its `paymentType`, the label the sales journal maps to a
 * GL account and the reconciliation counts as tender. So a tender may not take
 * a built-in's label (its payments would book and count as that built-in) or
 * the deposit offset's (they would book as the deposit, not as money received).
 */
export function tenderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name the payment type.";
  if (trimmed.length > TENDER_NAME_MAX) {
    return `A payment type's name can be at most ${TENDER_NAME_MAX} characters.`;
  }
  const lower = trimmed.toLowerCase();
  if (Object.values(METHOD_DISPLAY).some((label) => label.toLowerCase() === lower)) {
    return `"${trimmed}" is a built-in payment type. Name this one for who pays, such as the finance company.`;
  }
  if (DEPOSIT_OFFSET_LABELS.some((label) => label.toLowerCase() === lower)) {
    return `"${trimmed}" is the customer-deposit account's label in the GL mapping, so payments with this name would book as deposits. Pick another name.`;
  }
  return null;
}
