// /app/src/lib/messages/render.ts
//
// A customer message as the store wrote it, with its {placeholders} filled
// (lib/messages/catalog.ts lists them) and its links added. Pure.
//
// Filling is one pass over the store's text, so a value is never read again
// for placeholders: a customer named "{order}" is printed as typed.

import { customerMessageEmail, type RenderedEmail } from "@/lib/email/templates";
import type { Placeholder } from "./catalog";

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;

export type PlaceholderValues = Partial<Record<Placeholder, string>>;

export function fillPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) =>
    key in values ? (values[key as Placeholder] ?? "") : whole,
  );
}

/** {customer}: the first name, else the full name, else "there" ("Hi there,"). */
export function customerName(c: { firstName: string | null; lastName: string | null }): string {
  const first = c.firstName?.trim();
  if (first) return first;
  const last = c.lastName?.trim();
  return last || "there";
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** {pieces}: "Hartwell Sofa", "2 × Ellis Side Chair and Oak Table". */
export function describePieces(pieces: { name: string; quantity: number }[]): string {
  const named = pieces.map((p) =>
    round(p.quantity) === 1 ? p.name : `${round(p.quantity)} × ${p.name}`,
  );
  if (named.length <= 1) return named[0] ?? "";
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * {when}: the delivery day (YYYY-MM-DD, lib/messages/timing.ts runDay) in the
 * store's locale, with the time window dispatch gave the delivery, if any:
 * "Thursday, November 5" or "Thursday, November 5, 9am-12pm".
 */
export function describeWhen(day: string, window: string | null, locale: string): string {
  let date: string;
  try {
    date = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${day}T00:00:00.000Z`));
  } catch {
    date = day;
  }
  const time = window?.trim();
  return time ? `${date}, ${time}` : date;
}

/** Said in a text unless the store's own wording already says it (GAP-12). */
export const STOP_NOTICE = "Reply STOP to opt out.";

/**
 * A text as the store wrote it: its placeholders filled, then its links, one to
 * a line, then how to opt out. The store's wording is read for the word STOP
 * before anything is filled in, so a customer named Stop can't remove the notice.
 */
export function renderTextMessage(m: {
  body: string;
  values: PlaceholderValues;
  orderUrl: string | null;
  reviewUrl: string | null;
}): string {
  const lines = [fillPlaceholders(m.body, m.values).trim()];
  if (m.reviewUrl) lines.push(m.reviewUrl);
  if (m.orderUrl) lines.push(m.orderUrl);
  if (!/\bstop\b/i.test(m.body)) lines.push(STOP_NOTICE);
  return lines.join("\n");
}

export interface MessageToRender {
  subject: string;
  body: string;
  storeName: string;
  values: PlaceholderValues;
  /** The customer's order page, when the message includes it. */
  orderUrl: string | null;
  /** The store's review page, for the review invitation. */
  reviewUrl: string | null;
}

export function renderCustomerMessage(m: MessageToRender): RenderedEmail {
  const links: { label: string; url: string }[] = [];
  if (m.reviewUrl) links.push({ label: "Leave a review", url: m.reviewUrl });
  if (m.orderUrl) links.push({ label: "View your order", url: m.orderUrl });
  return customerMessageEmail({
    storeName: m.storeName,
    subject: fillPlaceholders(m.subject, m.values),
    text: fillPlaceholders(m.body, m.values),
    links,
  });
}
