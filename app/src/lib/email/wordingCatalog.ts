// /app/src/lib/email/wordingCatalog.ts
//
// GAP-37: the emails Holt sends, as the code knows them, and what each says until a store
// words it otherwise (Admin > Setup > Email look and wording). A store can change the
// subject, heading, opening and closing. What goes between them, a list of follow-ups or an
// invoice's lines, stays the template's, and so does any button: the wording can't drop a
// password reset's link. Plain text with {placeholders}, so no store's wording can carry
// markup or logic (rule 62).
//
// Customer messages have their own screen and rows (lib/messages/catalog.ts), since they
// also choose when they go.
//
// Pure: the screen and the server share it (rules 7, 37). __tests__/emailLook.test.ts fails
// if a template in lib/email/templates.ts isn't here.

import { fillPlaceholders, placeholdersIn } from "./fill";

export const EMAIL_KINDS = [
  "follow-up",
  "low-stock",
  "booking",
  "ticket-received",
  "ticket-reply",
  "invoice",
  "password-reset",
  "purchase-order",
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export function isEmailKind(value: unknown): value is EmailKind {
  return typeof value === "string" && (EMAIL_KINDS as readonly string[]).includes(value);
}

export interface EmailWordingText {
  subject: string;
  heading: string;
  intro: string;
  closing: string;
}

/** What a store has changed. Anything null or missing is the suggested wording. */
export type EmailWordingOverride = Partial<Record<keyof EmailWordingText, string | null>>;

export const EMAIL_WORDING_FIELDS = ["subject", "heading", "intro", "closing"] as const;

export interface EmailKindInfo extends EmailWordingText {
  name: string;
  /** Who gets it, to word it for them. */
  goesTo: string;
  placeholders: Record<string, string>;
}

const STORE = "Your store's name";

export const EMAIL_CATALOG: Record<EmailKind, EmailKindInfo> = {
  "follow-up": {
    name: "Morning follow-up email",
    goesTo: "Each salesperson",
    placeholders: { name: "The salesperson's name", summary: "How much is waiting", store: STORE },
    subject: "Your follow-ups: {summary}",
    heading: "Your follow-ups: {summary}",
    intro: "Good morning {name},",
    closing: "",
  },
  "low-stock": {
    name: "Low stock list",
    goesTo: "Whoever you listed in Settings",
    placeholders: { items: 'How many, as "3 items"', store: STORE },
    subject: "{items} below their reorder point",
    heading: "{items} below their reorder point",
    intro: "",
    closing: "",
  },
  booking: {
    name: "Booking confirmation",
    goesTo: "The customer",
    placeholders: {
      customer: "The customer's name",
      service: 'What they booked, or "booking"',
      store: STORE,
    },
    subject: "Your {service} with {store} is confirmed",
    heading: "Booking confirmed",
    intro: "Hi {customer},\n\nYour {service} is confirmed for:",
    closing: "We look forward to seeing you. Reply to this email if you need to make a change.",
  },
  "ticket-received": {
    name: "Support request received",
    goesTo: "Whoever asked",
    placeholders: { name: "Their name", ticket: "The request's number", store: STORE },
    subject: "[{ticket}] We received your request",
    heading: "Request received",
    intro: "Hi {name},\n\nThanks for reaching out. We've logged your request {ticket}:",
    closing: "You can check its status and reply any time:",
  },
  "ticket-reply": {
    name: "Reply to a support request",
    goesTo: "Whoever asked",
    placeholders: { name: "Their name", ticket: "The request's number", store: STORE },
    subject: "[{ticket}] New reply to your request",
    heading: "New reply",
    intro: "Hi {name},\n\nThere's a new reply on your request {ticket}:",
    closing: "",
  },
  invoice: {
    name: "Invoice",
    goesTo: "The customer",
    placeholders: {
      customer: "The customer's name",
      invoice: "The invoice's number",
      total: "Its total",
      store: STORE,
    },
    subject: "Invoice {invoice} from {store}",
    heading: "Invoice {invoice}",
    intro: "Hi {customer},\n\nInvoice {invoice} for {total} is ready.",
    closing: "Reply to this email with any questions.",
  },
  "password-reset": {
    name: "Password reset",
    goesTo: "Whoever asked to reset theirs",
    placeholders: { name: "Their name", store: STORE },
    subject: "Reset your {store} password",
    heading: "Password reset",
    intro: "Hi {name},\n\nSomeone (hopefully you) asked to reset your {store} password.",
    closing:
      "The link works once and expires in 1 hour. If you didn't ask for this, ignore this email. Your password is unchanged.",
  },
  "purchase-order": {
    name: "Purchase order",
    goesTo: "The vendor",
    placeholders: { vendor: "The vendor's name", po: "The PO's number", store: STORE },
    subject: "Purchase order {po} from {store}",
    heading: "Purchase order {po}",
    intro: "Hello {vendor},\n\nOur purchase order {po} is attached.",
    closing: "Please reply to confirm it and the date it will ship.",
  },
};

export const EMAIL_WORDING_MAX = 2000;
export const EMAIL_SUBJECT_MAX = 200;

/** The wording this email goes out with, placeholders filled. Not yet escaped. */
export function emailText(
  kind: EmailKind,
  override: EmailWordingOverride,
  values: Readonly<Record<string, string>>,
): EmailWordingText {
  const info = EMAIL_CATALOG[kind];
  // A value stays on one line, so a line break in a customer's name can't start a paragraph.
  const oneLine = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.replace(/\s*[\r\n]+\s*/g, " ")]),
  );
  const pick = (field: keyof EmailWordingText) =>
    fillPlaceholders(override[field] ?? info[field], oneLine);
  return {
    subject: pick("subject")
      .replace(/\s*[\r\n]+\s*/g, " ")
      .trim(),
    heading: pick("heading").trim(),
    intro: pick("intro").trim(),
    closing: pick("closing").trim(),
  };
}

/** Why this wording can't be saved, or null. */
export function emailWordingProblem(kind: EmailKind, input: EmailWordingOverride): string | null {
  const known = EMAIL_CATALOG[kind].placeholders;
  for (const field of EMAIL_WORDING_FIELDS) {
    const text = input[field];
    if (text === null || text === undefined) continue;
    const max = field === "subject" ? EMAIL_SUBJECT_MAX : EMAIL_WORDING_MAX;
    if (text.length > max) return `The ${field} can be up to ${max} characters.`;
    const unknown = placeholdersIn(text).find((name) => !(name in known));
    if (unknown) return `This email has no {${unknown}}. It has: ${Object.keys(known).join(", ")}.`;
  }
  if (input.subject !== null && input.subject !== undefined && !input.subject.trim()) {
    return "An email needs a subject.";
  }
  return null;
}
