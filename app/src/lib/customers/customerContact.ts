// /app/src/lib/customers/customerContact.ts
//
// What a customer create or edit may set from a form: names, email and phone,
// whether they want automatic messages (GAP-13), and whether they agreed to
// texts and how they'd rather hear from the store (GAP-12). Nothing else -- the referral fields are read by lib/customers/referrals.ts,
// and the rest of a customer (store credit, AR balance, trade status, tax
// exemption, level) has its own route and its own permission.
//
// POST /api/customers used to write `...req.body` into the new row, so any
// caller with "Edit customers" could create a customer holding store credit, a
// trade account or a tax exemption, outside the ledger and the gates that guard
// them (found 2026-11-01, GAP-08).

import { getErrorCode } from "@/lib/errorCode";

export class CustomerInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "CustomerInputError";
  }
}

const FIELD_MAX = 120;

export interface CustomerContact {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  /** They asked for no automatic messages (lib/messages/due.ts). */
  autoMessagesOptOut?: boolean;
  /** How they'd rather hear from the store; null clears it. */
  preferredChannel?: string | null;
}

/** The channels a customer can prefer. */
export const PREFERRED_CHANNELS = ["EMAIL", "TEXT", "BOTH"] as const;

function readText(raw: unknown, label: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new CustomerInputError(`${label} must be text.`);
  const text = raw.trim();
  if (text.length > FIELD_MAX) {
    throw new CustomerInputError(`${label} must be under ${FIELD_MAX} characters.`);
  }
  return text || null;
}

function readFlag(raw: unknown, label: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new CustomerInputError(`${label} must be true or false.`);
  return raw;
}

function readPreferredChannel(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (!PREFERRED_CHANNELS.some((channel) => channel === raw)) {
    throw new CustomerInputError("Choose email, text or both.");
  }
  return raw as string;
}

/**
 * The columns for "they agreed to texts" (GAP-12), when a form sent it. Ticking
 * a box already ticked keeps the original who and when, which is the record of
 * their consent; unticking clears it.
 */
export function textConsentChange(
  raw: unknown,
  current: { smsConsentAt: Date | null } | null,
  actor: string | null,
): { smsConsentAt?: Date | null; smsConsentBy?: string | null } {
  if (raw === undefined) return {};
  const agreed = readFlag(raw, "Agreed to texts");
  if (!agreed) return { smsConsentAt: null, smsConsentBy: null };
  return current?.smsConsentAt ? {} : { smsConsentAt: new Date(), smsConsentBy: actor };
}

/** The contact fields of a body; absent ones are left out, blank ones cleared. */
export function readContact(body: Record<string, unknown>): CustomerContact {
  const contact: CustomerContact = {
    firstName: readText(body.firstName, "First name"),
    lastName: readText(body.lastName, "Last name"),
    email: readText(body.email, "Email"),
    phone: readText(body.phone, "Phone"),
    autoMessagesOptOut: readFlag(body.autoMessagesOptOut, "No automatic messages"),
    preferredChannel: readPreferredChannel(body.preferredChannel),
  };
  if (contact.email && !/^[^\s@]+@[^\s@]+$/.test(contact.email)) {
    throw new CustomerInputError("That email doesn't look like an email address.");
  }
  for (const key of Object.keys(contact) as (keyof CustomerContact)[]) {
    if (contact[key] === undefined) delete contact[key];
  }
  return contact;
}

/** A new customer needs something to be known by: a name or an email. */
export function assertIdentifiable(contact: CustomerContact): void {
  if (!contact.firstName && !contact.lastName && !contact.email) {
    throw new CustomerInputError("Give the customer a name or an email.");
  }
}

/**
 * A unique-constraint clash on a customer write. Email is the only unique
 * column these writes set, so a clash is a duplicate email.
 */
export function isDuplicateEmail(err: unknown): boolean {
  return getErrorCode(err) === "P2002";
}
