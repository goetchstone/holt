// /app/src/lib/email/templates.ts
//
// Pure transactional email templates -> { subject, html }. Inline styles only
// (email clients drop <style>/external CSS). All interpolated values are
// HTML-escaped so author/customer text can never inject markup. No I/O.

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

function layout(appName: string, heading: string, bodyHtml: string): string {
  const safeApp = escapeHtml(appName);
  // "Sent by Holt Home & Rug Co." -- a name that ends in a full stop gets one, not two.
  const signedBy = escapeHtml(appName.trim().replace(/\.+$/, ""));
  return `<!doctype html><html><body style="margin:0;background:#f5f4f0;font-family:Helvetica,Arial,sans-serif;color:#14161f">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:20px;color:#1c1f2e;margin:0 0 16px">${safeApp}</h1>
    <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2>
    ${bodyHtml}
    <p style="font-size:12px;color:#9a968d;margin-top:32px">Sent by ${signedBy}.</p>
  </div></body></html>`;
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
}

export function bookingConfirmationEmail(input: BookingEmailInput): RenderedEmail {
  const when = formatDateTime(input.startsAt, input.timezone);
  const svc = input.serviceName ? `${input.serviceName} ` : "";
  const subject = `Your ${svc}booking with ${input.appName} is confirmed`;
  const body = `<p>Hi ${escapeHtml(input.customerName)},</p>
    <p>Your ${input.serviceName ? `<strong>${escapeHtml(input.serviceName)}</strong> ` : ""}appointment is confirmed for:</p>
    <p style="font-size:16px"><strong>${escapeHtml(when)}</strong></p>
    <p>We look forward to seeing you. Reply to this email if you need to make a change.</p>`;
  return { subject, html: layout(input.appName, "Booking confirmed", body) };
}

export interface TicketEmailInput {
  appName: string;
  submitterName?: string | null;
  ticketNumber: string;
  subject: string;
  statusUrl: string;
}

export function ticketReceivedEmail(input: TicketEmailInput): RenderedEmail {
  const subject = `[${input.ticketNumber}] We received your request`;
  const body = `<p>Hi ${escapeHtml(input.submitterName ?? "there")},</p>
    <p>Thanks for reaching out — we've logged your request <strong>${escapeHtml(input.ticketNumber)}</strong>:</p>
    <p style="padding:12px;background:#e8e4dc;border-radius:6px">${escapeHtml(input.subject)}</p>
    <p>You can check its status and reply any time:</p>
    <p><a href="${escapeHtml(input.statusUrl)}" style="color:#1c1f2e">${escapeHtml(input.statusUrl)}</a></p>`;
  return { subject, html: layout(input.appName, "Request received", body) };
}

export interface TicketReplyEmailInput extends TicketEmailInput {
  messageBody: string;
}

export function ticketReplyEmail(input: TicketReplyEmailInput): RenderedEmail {
  const subject = `[${input.ticketNumber}] New reply to your request`;
  const body = `<p>Hi ${escapeHtml(input.submitterName ?? "there")},</p>
    <p>There's a new reply on your request <strong>${escapeHtml(input.ticketNumber)}</strong>:</p>
    <p style="padding:12px;background:#e8e4dc;border-radius:6px;white-space:pre-wrap">${escapeHtml(input.messageBody)}</p>
    <p><a href="${escapeHtml(input.statusUrl)}" style="color:#1c1f2e">View &amp; reply</a></p>`;
  return { subject, html: layout(input.appName, "New reply", body) };
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
}

export function invoiceIssuedEmail(input: InvoiceEmailInput): RenderedEmail {
  const subject = `Invoice ${input.invoiceNo} from ${input.appName}`;
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
    ? `<p style="margin:24px 0"><a href="${escapeHtml(input.paymentUrl)}" style="background:#1c1f2e;color:#f5f4f0;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Pay ${escapeHtml(input.openBalanceFormatted)} now</a></p>`
    : "";
  const body = `<p>Hi ${escapeHtml(input.customerName)},</p>
    <p>Invoice <strong>${escapeHtml(input.invoiceNo)}</strong> for <strong>${escapeHtml(input.totalFormatted)}</strong> is ready.</p>
    ${due}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
      <thead><tr>
        <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #1c1f2e">Description</th>
        <th style="padding:6px 8px;text-align:right;border-bottom:2px solid #1c1f2e">Qty</th>
        <th style="padding:6px 8px;text-align:right;border-bottom:2px solid #1c1f2e">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${pay}
    <p>Reply to this email with any questions.</p>`;
  return { subject, html: layout(input.appName, `Invoice ${input.invoiceNo}`, body) };
}

export interface PasswordResetEmailInput {
  appName: string;
  displayName: string;
  resetUrl: string;
}

export function passwordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const subject = `Reset your ${input.appName} password`;
  const body = `<p>Hi ${escapeHtml(input.displayName)},</p>
    <p>Someone (hopefully you) asked to reset your ${escapeHtml(input.appName)} password.</p>
    <p style="margin:24px 0"><a href="${escapeHtml(input.resetUrl)}" style="background:#1c1f2e;color:#f5f4f0;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Choose a new password</a></p>
    <p>The link works once and expires in 1 hour. If you didn't ask for this, ignore this email — your password is unchanged.</p>`;
  return { subject, html: layout(input.appName, "Password reset", body) };
}

export interface PurchaseOrderEmailInput {
  /** The store's name, as the PO's PDF prints it. */
  companyName: string;
  vendorName: string;
  poNumber: string;
  /** The sender's own note, if they wrote one. */
  message?: string | null;
}

export function purchaseOrderEmail(input: PurchaseOrderEmailInput): RenderedEmail {
  const subject = `Purchase order ${input.poNumber} from ${input.companyName}`;
  const note = input.message?.trim()
    ? `<p>${escapeHtml(input.message.trim()).replace(/\r?\n/g, "<br>")}</p>`
    : "";
  const body = `<p>Hello ${escapeHtml(input.vendorName)},</p>
    <p>Our purchase order <strong>${escapeHtml(input.poNumber)}</strong> is attached.</p>
    ${note}
    <p>Please reply to confirm it and the date it will ship.</p>`;
  return {
    subject,
    html: layout(input.companyName, `Purchase order ${input.poNumber}`, body),
  };
}

export interface CustomerMessageEmailInput {
  /** The store's name, at the head and foot. */
  storeName: string;
  /** The store's own subject and wording, placeholders already filled (lib/messages/render.ts). */
  subject: string;
  text: string;
  /** Buttons under the wording: the order link, the review page. */
  links: { label: string; url: string }[];
}

/**
 * An automatic customer message (GAP-13) in the store's own words. Plain text:
 * a blank line starts a paragraph and a line break stays one, and all of it is
 * escaped, so neither the store's wording nor a customer's name can inject
 * markup.
 */
export function customerMessageEmail(input: CustomerMessageEmailInput): RenderedEmail {
  const paragraphs = input.text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n    ");
  const buttons = input.links
    .map(
      (l) =>
        `<p style="margin:24px 0"><a href="${escapeHtml(l.url)}" style="background:#1c1f2e;color:#f5f4f0;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(l.label)}</a></p>`,
    )
    .join("\n    ");
  const subject = input.subject.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return { subject, html: layout(input.storeName, subject, `${paragraphs}\n    ${buttons}`) };
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
}

/** How many a list in an email shows; the screen has them all. */
const LOW_STOCK_EMAIL_MAX_ROWS = 100;

/** The daily list of what's below its reorder point (GAP-14). */
export function lowStockEmail(input: LowStockEmailInput): RenderedEmail {
  const count = input.rows.length;
  const subject = `${count} item${count === 1 ? "" : "s"} below their reorder point`;
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
  const th = "padding:6px 8px;border-bottom:2px solid #1c1f2e";
  const body = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
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
    <p style="margin:24px 0"><a href="${escapeHtml(input.url)}" style="background:#1c1f2e;color:#f5f4f0;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Order from Low stock</a></p>`;
  return { subject, html: layout(input.storeName, subject, body) };
}
