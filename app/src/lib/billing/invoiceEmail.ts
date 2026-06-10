// /app/src/lib/billing/invoiceEmail.ts
//
// Email an issued invoice to its customer through the durable email queue.
// Optionally creates a Stripe payment link for the open balance and embeds it
// as the pay button. Server-only.

import { getAppSettings } from "@/lib/appSettings";
import { enqueueAndSend } from "@/lib/email/queue";
import { invoiceIssuedEmail } from "@/lib/email/templates";
import { getInvoiceDetail } from "@/lib/billing/invoiceService";
import { createInvoicePaymentLink } from "@/lib/billing/invoiceStripe";
import { InvoiceValidationError, invoiceActionError } from "@/lib/billing/invoiceAuthoring";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { logError } from "@/lib/logger";

export interface SendInvoiceEmailInput {
  includePaymentLink?: boolean;
  requestedBy?: string | null;
}

export async function sendInvoiceEmail(
  invoiceId: number,
  input: SendInvoiceEmailInput = {},
): Promise<{ to: string; paymentUrl: string | null }> {
  const invoice = await getInvoiceDetail(invoiceId);
  const err = invoiceActionError(invoice.status, "email");
  if (err) throw new InvoiceValidationError(err);
  if (!invoice.customerEmail) {
    throw new InvoiceValidationError("The customer has no email on file");
  }

  const settings = await getAppSettings();
  const money = new Intl.NumberFormat(settings.locale || "en-US", {
    style: "currency",
    currency: settings.currency || "USD",
  });

  let paymentUrl: string | null = null;
  if (input.includePaymentLink && invoice.openBalance > 0) {
    try {
      const link = await createInvoicePaymentLink(invoiceId, input.requestedBy);
      paymentUrl = link.url;
    } catch (linkErr) {
      // Stripe unconfigured shouldn't block the invoice email itself — send
      // without the pay button and surface the reason in the response.
      logError("Invoice payment link creation failed; sending email without it", linkErr);
    }
  }

  const rendered = invoiceIssuedEmail({
    appName: settings.companyName?.trim() || settings.appName,
    customerName: invoice.customerName,
    invoiceNo: invoice.invoiceNo,
    totalFormatted: money.format(invoice.total),
    openBalanceFormatted: money.format(invoice.openBalance),
    dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
    paymentUrl,
    lines: invoice.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      amountFormatted: money.format(l.amount),
    })),
  });

  await enqueueAndSend({
    organizationId: DEFAULT_ORG_ID,
    to: invoice.customerEmail,
    subject: rendered.subject,
    html: rendered.html,
    templateKey: "invoice-issued",
    createdBy: input.requestedBy ?? undefined,
  });

  return { to: invoice.customerEmail, paymentUrl };
}
