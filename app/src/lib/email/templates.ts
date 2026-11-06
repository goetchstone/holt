// /app/src/lib/email/templates.ts
//
// Pure transactional email templates -> { subject, html }. Inline styles only
// (email clients drop <style>/external CSS). All interpolated values are
// HTML-escaped so author/customer text can never inject markup. No I/O.
//
// Every email takes the store's look, and all but a customer message its wording
// (GAP-37). Both are required, so a new email can't skip them without a compile error:
// getEmailChrome in lib/email/wordingSettings.ts reads them.

import { DEFAULT_EMAIL_LOOK, textOn, type EmailLook } from "./look";
import { emailText, type EmailWordingOverride, type EmailWordingText } from "./wordingCatalog";

export interface EmailChrome {
  look: EmailLook;
  wording: EmailWordingOverride;
}

/** The default look and the suggested wording. */
export const DEFAULT_EMAIL_CHROME: EmailChrome = { look: DEFAULT_EMAIL_LOOK, wording: {} };

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function formatDateTime(date: Date, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: timezone || undefined,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** A store's text as paragraphs: a blank line starts one, a line break stays one. Escaped. */
function paragraphs(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\r?\n\s*\r?\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n    ");
}

function button(url: string, label: string, look: EmailLook): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:${look.accent};color:${textOn(look.accent)};padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>`;
}

function layout(appName: string, heading: string, bodyHtml: string, look: EmailLook): string {
  const safeApp = escapeHtml(appName);
  // "Sent by Holt Home & Rug Co." -- a name that ends in a full stop gets one, not two.
  const signedBy = escapeHtml(appName.trim().replace(/\.+$/, ""));
  const head = look.logoUrl
    ? `<img src="${escapeHtml(look.logoUrl)}" alt="${safeApp}" style="max-height:48px;max-width:240px;margin:0 0 16px;display:block">`
    : `<h1 style="font-size:20px;color:${look.accent};margin:0 0 16px">${safeApp}</h1>`;
  const foot = look.footer
    ? escapeHtml(look.footer.trim()).replace(/\r?\n/g, "<br>")
    : `Sent by ${signedBy}.`;
  return `<!doctype html><html><body style="margin:0;background:#f5f4f0;font-family:Helvetica,Arial,sans-serif;color:#14161f">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    ${head}
    <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2>
    ${bodyHtml}
    <p style="font-size:12px;color:#9a968d;margin-top:32px">${foot}</p>
  </div></body></html>`;
}

function rendered(
  store: string,
  text: EmailWordingText,
  bodyHtml: string,
  look: EmailLook,
): RenderedEmail {
  return { subject: text.subject, html: layout(store, text.heading, bodyHtml, look) };
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export interface BookingEmailInput {
  appName: string;
  customerName: string;
  serviceName?: string | null;
  startsAt: Date;
  timezone?: string;
  chrome: EmailChrome;
}

export function bookingConfirmationEmail(input: BookingEmailInput): RenderedEmail {
  const { look, wording } = input.chrome;
  const when = formatDateTime(input.startsAt, input.timezone);
  const text = emailText("booking", wording, {
    customer: input.customerName,
    service: input.serviceName || "booking",
    store: input.appName,
  });
  const body = `${paragraphs(text.intro)}
    <p style="font-size:16px"><strong>${escapeHtml(when)}</strong></p>
    ${paragraphs(text.closing)}`;
  return rendered(input.appName, text, body, look);
}

export interface TicketEmailInput {
  appName: string;
  submitterName?: string | null;
  ticketNumber: string;
  subject: string;
  statusUrl: string;
  chrome: EmailChrome;
}

export function ticketReceivedEmail(input: TicketEmailInput): RenderedEmail {
  const { look, wording } = input.chrome;
  const text = emailText("ticket-received", wording, {
    name: input.submitterName ?? "there",
    ticket: input.ticketNumber,
    store: input.appName,
  });
  const body = `${paragraphs(text.intro)}
    <p style="padding:12px;background:#e8e4dc;border-radius:6px">${escapeHtml(input.subject)}</p>
    ${paragraphs(text.closing)}
    <p><a href="${escapeHtml(input.statusUrl)}" style="color:${look.accent}">${escapeHtml(input.statusUrl)}</a></p>`;
  return rendered(input.appName, text, body, look);
}

export interface TicketReplyEmailInput extends TicketEmailInput {
  messageBody: string;
}

export function ticketReplyEmail(input: TicketReplyEmailInput): RenderedEmail {
  const { look, wording } = input.chrome;
  const text = emailText("ticket-reply", wording, {
    name: input.submitterName ?? "there",
    ticket: input.ticketNumber,
    store: input.appName,
  });
  const body = `${paragraphs(text.intro)}
    <p style="padding:12px;background:#e8e4dc;border-radius:6px;white-space:pre-wrap">${escapeHtml(input.messageBody)}</p>
    ${paragraphs(text.closing)}
    <p><a href="${escapeHtml(input.statusUrl)}" style="color:${look.accent}">View &amp; reply</a></p>`;
  return rendered(input.appName, text, body, look);
}

export interface InvoiceEmailInput {
  appName: string;
  customerName: string;
  invoiceNo: string;
  /** Pre-formatted money strings (the caller owns currency/locale). */
  totalFormatted: string;
  openBalanceFormatted: string;
  dueDate?: Date | null;
  /** Stripe checkout URL when a payment link was generated alongside. */
  paymentUrl?: string | null;
  lines: { description: string; quantity: number; amountFormatted: string }[];
  chrome: EmailChrome;
}

export function invoiceIssuedEmail(input: InvoiceEmailInput): RenderedEmail {
  const { look, wording } = input.chrome;
  const text = emailText("invoice", wording, {
    customer: input.customerName,
    invoice: input.invoiceNo,
    total: input.totalFormatted,
    store: input.appName,
  });
  const due = input.dueDate
    ? `<p>Due by <strong>${escapeHtml(
        new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(input.dueDate),
      )}</strong>.</p>`
    : "";
  const rows = input.lines
    .map(
      (l) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e4dc">${escapeHtml(l.description)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e4dc;text-align:right">${l.quantity}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e8e4dc;text-align:right">${escapeHtml(l.amountFormatted)}</td>
      </tr>`,
    )
    .join("");
  const pay = input.paymentUrl
    ? button(input.paymentUrl, `Pay ${input.openBalanceFormatted} now`, look)
    : "";
  const rule = `border-bottom:2px solid ${look.accent}`;
  const body = `${paragraphs(text.intro)}
    ${due}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
      <thead><tr>
        <th style="padding:6px 8px;text-align:left;${rule}">Description</th>
        <th style="padding:6px 8px;text-align:right;${rule}">Qty</th>
        <th style="padding:6px 8px;text-align:right;${rule}">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${pay}
    ${paragraphs(text.closing)}`;
  return rendered(input.appName, text, body, look);
}

export interface PasswordResetEmailInput {
  appName: string;
  displayName: string;
  resetUrl: string;
  chrome: EmailChrome;
}

export function passwordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const { look, wording } = input.chrome;
  const text = emailText("password-reset", wording, {
    name: input.displayName,
    store: input.appName,
  });
  const body = `${paragraphs(text.intro)}
    ${button(input.resetUrl, "Choose a new password", look)}
    ${paragraphs(text.closing)}`;
  return rendered(input.appName, text, body, look);
}

export interface PurchaseOrderEmailInput {
  /** The store's name, as the PO's PDF prints it. */
  companyName: string;
  vendorName: string;
  poNumber: string;
  /** The sender's own note, if they wrote one. */
  message?: string | null;
  chrome: EmailChrome;
}

export function purchaseOrderEmail(input: PurchaseOrderEmailInput): RenderedEmail {
  const { look, wording } = input.chrome;
  const text = emailText("purchase-order", wording, {
    vendor: input.vendorName,
    po: input.poNumber,
    store: input.companyName,
  });
  const note = input.message?.trim()
    ? `<p>${escapeHtml(input.message.trim()).replace(/\r?\n/g, "<br>")}</p>`
    : "";
  const body = `${paragraphs(text.intro)}
    ${note}
    ${paragraphs(text.closing)}`;
  return rendered(input.companyName, text, body, look);
}

export interface CustomerMessageEmailInput {
  /** The store's name, at the head and foot. */
  storeName: string;
  /** The store's own subject and wording, placeholders already filled (lib/messages/render.ts). */
  subject: string;
  text: string;
  /** Buttons under the wording: the order link, the review page. */
  links: { label: string; url: string }[];
  look: EmailLook;
}

/**
 * An automatic customer message (GAP-13) in the store's own words. Plain text:
 * a blank line starts a paragraph and a line break stays one, and all of it is
 * escaped, so neither the store's wording nor a customer's name can inject
 * markup.
 */
export function customerMessageEmail(input: CustomerMessageEmailInput): RenderedEmail {
  const buttons = input.links.map((l) => button(l.url, l.label, input.look)).join("\n    ");
  const subject = input.subject.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return {
    subject,
    html: layout(input.storeName, subject, `${paragraphs(input.text)}\n    ${buttons}`, input.look),
  };
}

export interface LowStockEmailInput {
  storeName: string;
  rows: {
    store: string;
    productName: string;
    free: number;
    onOrder: number;
    minQuantity: number;
    suggested: number;
  }[];
  /** Purchasing > Low stock. */
  url: string;
  chrome: EmailChrome;
}

/** How many a list in an email shows; the screen has them all. */
const LOW_STOCK_EMAIL_MAX_ROWS = 100;

/** The daily list of what's below its reorder point (GAP-14). */
export function lowStockEmail(input: LowStockEmailInput): RenderedEmail {
  const count = input.rows.length;
  const { look, wording } = input.chrome;
  const text = emailText("low-stock", wording, {
    items: `${count} item${count === 1 ? "" : "s"}`,
    store: input.storeName,
  });
  const cell = "padding:6px 8px;border-bottom:1px solid #e8e4dc";
  const num = `${cell};text-align:right`;
  const rows = input.rows
    .slice(0, LOW_STOCK_EMAIL_MAX_ROWS)
    .map(
      (r) => `<tr>
        <td style="${cell}">${escapeHtml(r.store)}</td>
        <td style="${cell}">${escapeHtml(r.productName)}</td>
        <td style="${num}">${r.free}</td>
        <td style="${num}">${r.onOrder}</td>
        <td style="${num}">${r.minQuantity}</td>
        <td style="${num}">${r.suggested === 0 ? "On a draft" : r.suggested}</td>
      </tr>`,
    )
    .join("");
  const more =
    count > LOW_STOCK_EMAIL_MAX_ROWS ? `<p>And ${count - LOW_STOCK_EMAIL_MAX_ROWS} more.</p>` : "";
  const th = `padding:6px 8px;border-bottom:2px solid ${look.accent}`;
  const body = `${paragraphs(text.intro)}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
      <thead><tr>
        <th style="${th};text-align:left">Store</th>
        <th style="${th};text-align:left">Item</th>
        <th style="${th};text-align:right">Free</th>
        <th style="${th};text-align:right">On order</th>
        <th style="${th};text-align:right">Keep</th>
        <th style="${th};text-align:right">Order</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${more}
    ${button(input.url, "Order from Low stock", look)}
    ${paragraphs(text.closing)}`;
  return rendered(input.storeName, text, body, look);
}

export interface FollowUpEmailClient {
  name: string;
  detail: string;
}

export interface FollowUpEmailInput {
  storeName: string;
  staffName: string;
  baseUrl: string;
  due: FollowUpEmailClient[];
  quotesWaiting: number;
  suggested: FollowUpEmailClient[];
  suggestedCount: number;
  suggestedWhy: string;
  chrome: EmailChrome;
}

export const FOLLOW_UP_EMAIL_MAX_DUE = 15;

function followUpSummary(input: FollowUpEmailInput): string {
  const count = (n: number, word: string) =>
    `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (input.due.length > 0) parts.push(`${input.due.length} due`);
  if (input.quotesWaiting > 0) parts.push(`${count(input.quotesWaiting, "quote")} waiting`);
  if (input.suggestedCount > 0) parts.push(`${count(input.suggestedCount, "past client")} to call`);
  return parts.join(", ");
}

/** Null when there's nothing to say, so nobody gets an empty email. */
export function followUpEmail(input: FollowUpEmailInput): RenderedEmail | null {
  const { due, quotesWaiting, suggested, suggestedCount, baseUrl } = input;
  if (due.length === 0 && quotesWaiting === 0 && suggestedCount === 0) return null;
  const { look, wording } = input.chrome;
  const text = emailText("follow-up", wording, {
    name: input.staffName,
    summary: followUpSummary(input),
    store: input.storeName,
  });

  const clientList = (clients: FollowUpEmailClient[]) =>
    `<ul style="margin:8px 0;padding-left:20px">${clients
      .map(
        (client) =>
          `<li style="margin:4px 0"><strong>${escapeHtml(client.name)}</strong>: ${escapeHtml(client.detail)}</li>`,
      )
      .join("")}</ul>`;
  const link = (path: string, label: string) =>
    `<p style="margin:8px 0"><a href="${escapeHtml(`${baseUrl}${path}`)}" style="color:${look.accent}">${label}</a></p>`;
  const heading = (text: string) => `<h3 style="margin:24px 0 8px;font-size:15px">${text}</h3>`;

  const sections = [paragraphs(text.intro)];
  if (due.length > 0) {
    const hidden = due.length - FOLLOW_UP_EMAIL_MAX_DUE;
    sections.push(
      heading(`Follow-ups due (${due.length})`),
      clientList(due.slice(0, FOLLOW_UP_EMAIL_MAX_DUE)),
      hidden > 0 ? `<p>And ${hidden} more.</p>` : "",
      link("/app/sales/clients?show=due", "See them all"),
    );
  }
  if (quotesWaiting > 0) {
    sections.push(
      heading(`Open quotes waiting on you (${quotesWaiting})`),
      link("/app/sales/pipeline", "Open your pipeline"),
    );
  }
  if (suggestedCount > 0) {
    sections.push(
      heading(`Past clients worth a call (${suggestedCount})`),
      `<p style="margin:8px 0">${escapeHtml(input.suggestedWhy)}</p>`,
      clientList(suggested),
      link("/app/sales/clients?show=suggested", "See the list"),
    );
  }
  sections.push(paragraphs(text.closing));
  return rendered(input.storeName, text, sections.join("\n"), look);
}
