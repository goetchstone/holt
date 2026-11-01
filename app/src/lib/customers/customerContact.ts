// /app/src/lib/customers/customerContact.ts
//
// What a customer create or edit may set from a form: names, email and phone.
// Nothing else -- the referral fields are read by lib/customers/referrals.ts,
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
}

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

/** The contact fields of a body; absent ones are left out, blank ones cleared. */
export function readContact(body: Record<string, unknown>): CustomerContact {
  const contact: CustomerContact = {
    firstName: readText(body.firstName, "First name"),
    lastName: readText(body.lastName, "Last name"),
    email: readText(body.email, "Email"),
    phone: readText(body.phone, "Phone"),
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
