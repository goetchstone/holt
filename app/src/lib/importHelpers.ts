// /app/src/lib/importHelpers.ts
//
// Shared, source-agnostic helpers for CSV/spreadsheet imports: value
// coercion (safeString / safeFloat / safeDate), customer-name splitting,
// and the canonical find-or-create-customer dedup routine. Importers
// across the app reuse these so dedup and coercion behave identically no
// matter which file fed the data.

import { PrismaClient, Customer } from "@prisma/client";

// ---------------------------------------------------------------------------
// Safe value coercion
// ---------------------------------------------------------------------------

export function safeString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v)
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (s === "" || s === "@") return undefined;
  return s;
}

export function safeFloat(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/[^0-9.\-]+/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function safeDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const parsed = new Date(String(v));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// ---------------------------------------------------------------------------
// Customer dedup / creation
// ---------------------------------------------------------------------------

/**
 * Split a free-form customer-name string ("First [Middle] Last") into
 * firstName + lastName. Returns null parts if the input is empty.
 */
export function splitCustomerName(customerName: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const trimmed = (customerName || "").trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const parts = trimmed.split(/\s+/);
  return {
    firstName: parts[0] || null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

// Returns true when an email is too untrustworthy to use as a customer-merge
// key — specifically, an address on the company's own domain. Staff sometimes
// type their OWN email when creating a customer, which would then merge every
// later customer they touch into the first one via the email match in
// findOrCreateCustomer. Set COMPANY_EMAIL_DOMAIN to enable this guard; real
// customers use external domains (gmail, comcast, yahoo, etc.) and pass
// through unchanged. Matched on the domain part only, so a customer whose
// local-part mentions the company name isn't false-flagged.
export function isUntrustedMergeEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = process.env.COMPANY_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return email
    .slice(at + 1)
    .toLowerCase()
    .includes(domain);
}

/**
 * Find an existing customer by external id, then trusted email + name, then
 * name alone; otherwise create one. The `externalId` links to a row in the
 * external-id table so a source system's customer code resolves to the same
 * customer on every import. Late-hydrates name/phone onto an earlier stub.
 */
export async function findOrCreateCustomer(
  prisma: PrismaClient,
  opts: {
    cuscode?: string;
    customerName?: string;
    email?: string;
    phone?: string;
    createdBy?: string;
  },
): Promise<Customer | null> {
  const { cuscode, customerName, email, phone, createdBy } = opts;
  if (!cuscode && !customerName) return null;

  let customer: Customer | null = null;

  if (cuscode) {
    const link = await prisma.customerExternalId.findUnique({
      where: { externalId: cuscode },
      include: { customer: true },
    });
    if (link) customer = link.customer;
  }

  // Skip email-based matching for untrusted emails (see
  // isUntrustedMergeEmail above) — these are staff-typed emails that
  // would wrongly cluster every customer they touch.
  //
  // When matching by email, ALSO require the incoming customerName to
  // match the existing record's firstName+lastName. Without the name
  // check, a real shared email between two unrelated entities still
  // wrongly clusters them. Email-only matches are deferred to the
  // by-name lookup below.
  if (!customer && email && !isUntrustedMergeEmail(email) && customerName) {
    const { firstName, lastName } = splitCustomerName(customerName);
    if (firstName) {
      customer = await prisma.customer.findFirst({
        where: { email, firstName, lastName: lastName || null },
      });
    }
  }

  if (!customer && customerName) {
    const { firstName, lastName } = splitCustomerName(customerName);
    if (firstName) {
      // For a single-name customer, splitCustomerName returns
      // lastName=null. An existing DB row may have stored that as NULL
      // or as ''. Prisma `lastName: ''` matches only the empty-string
      // form, missing NULL rows (three-valued logic). Use OR to match
      // either, so we don't create a duplicate single-name customer.
      const whereClause = lastName
        ? { firstName, lastName }
        : { firstName, OR: [{ lastName: null }, { lastName: "" }] };
      customer = await prisma.customer.findFirst({ where: whereClause });
    }
  }

  if (!customer && (customerName || cuscode)) {
    // Create a record from whatever identifiers we have. Even if ONLY
    // externalId is present (no name), create a placeholder so a related
    // order's customerId link is set; a later import hydrates real fields
    // via the external-id upsert below.
    //
    // Untrusted emails are dropped at create-time — Customer.email is
    // @unique, so storing the same staff email on multiple distinct
    // customers would fail the constraint, and the value isn't really
    // the customer's email anyway.
    //
    // Even a trusted email may already be on another Customer from an
    // unrelated import. The email-only-no-name tightening above means we
    // only MERGE when both name + email match, but the create here can
    // still collide on the @unique index. Look up the email first; if
    // it's taken, drop it (NULL) rather than crashing the whole batch.
    const parts = (customerName || "").trim().split(" ");
    const firstName = parts[0] || undefined;
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
    let safeEmail = email && !isUntrustedMergeEmail(email) ? email : undefined;
    if (safeEmail) {
      const collision = await prisma.customer.findUnique({
        where: { email: safeEmail },
        select: { id: true },
      });
      if (collision) safeEmail = undefined;
    }
    customer = await prisma.customer.create({
      data: {
        firstName,
        lastName,
        email: safeEmail,
        phone: phone || undefined,
        createdBy,
      },
    });
  }

  if (customer && cuscode) {
    await prisma.customerExternalId.upsert({
      where: { externalId: cuscode },
      update: { customerId: customer.id },
      create: { externalId: cuscode, customerId: customer.id, createdBy },
    });
  }

  if (customer && phone && !customer.phone) {
    await prisma.customer.update({
      where: { id: customer.id },
      data: { phone },
    });
  }

  // Late-hydrate name fields when an existing row was created earlier
  // with NULL firstName/lastName (typical pattern: an import landed an
  // external id + no name, creating a stub; a later import arrives with
  // the real name). Mirrors the phone update above.
  if (customer && customerName && (!customer.firstName || !customer.lastName)) {
    const { firstName, lastName } = splitCustomerName(customerName);
    const updates: { firstName?: string; lastName?: string } = {};
    if (firstName && !customer.firstName) updates.firstName = firstName;
    if (lastName && !customer.lastName) updates.lastName = lastName;
    if (Object.keys(updates).length > 0) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: updates,
      });
    }
  }

  return customer;
}
