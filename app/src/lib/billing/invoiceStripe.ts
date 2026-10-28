// /app/src/lib/billing/invoiceStripe.ts
//
// Hosted card checkout for authored invoices. The invoice's own rules live
// here (imported invoices and closed ones take no link, the customer needs an
// email, the open balance is total less applications); the checkout itself is
// paymentService.startHostedCheckout, the same one the order routes use. It
// refuses while a checkout on this invoice may still be open, opens the
// session, and stores a PENDING customer-linked Payment bound to the invoice.
// The webhook completes it (completePayment -> ledger) and then
// applyInvoiceStripePayment adds the application + AR_PAYMENT journal.
// Server-only (imports the Stripe client).

import { prisma } from "@/lib/prisma";
import { resolveCheckoutEmail } from "@/lib/stripe";
import { getAppSettings } from "@/lib/appSettings";
import { startHostedCheckout } from "@/lib/paymentService";
import { InvoiceValidationError, invoiceActionError } from "@/lib/billing/invoiceAuthoring";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface InvoicePaymentLink {
  url: string;
  amount: number;
}

/**
 * Throws `CheckoutAlreadyOpenError` (from paymentService) while a checkout on
 * this invoice may still be open, unless `force` voids that one first. Each
 * caller decides what that means for it: a 409, a CONFLICT, or an email sent
 * without the pay button.
 */
export async function createInvoicePaymentLink(
  invoiceId: number,
  requestedBy?: string | null,
  opts: { force?: boolean } = {},
): Promise<InvoicePaymentLink> {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      invoiceNo: true,
      status: true,
      total: true,
      organizationId: true,
      customer: { select: { email: true } },
      applications: { select: { amountApplied: true } },
    },
  });
  if (invoice.organizationId === null) {
    throw new InvoiceValidationError("Imported invoices cannot take payment links");
  }
  const err = invoiceActionError(invoice.status, "record-payment");
  if (err) throw new InvoiceValidationError(err);
  if (!invoice.customer?.email) {
    throw new InvoiceValidationError("The customer has no email on file");
  }
  let applied = 0;
  for (const a of invoice.applications) applied += Number(a.amountApplied);
  const open = round2(Number(invoice.total ?? 0) - applied);
  if (open <= 0) {
    throw new InvoiceValidationError("No open balance on this invoice");
  }

  const settings = await getAppSettings();
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

  const checkout = await startHostedCheckout({
    // Structural binding: the webhook routes on Payment.invoiceId, never on metadata.
    target: { invoiceId },
    amount: open,
    actor: requestedBy,
    force: opts.force,
    description: `Invoice ${invoice.invoiceNo} — ${settings.companyName || settings.appName}`,
    customerEmail: resolveCheckoutEmail(invoice.customer.email),
    metadata: {
      invoiceId: String(invoiceId),
      invoiceNo: invoice.invoiceNo,
      requestedBy: requestedBy ?? "",
    },
    urls: {
      successUrl: `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/app/payment/cancel?invoice_id=${invoiceId}`,
    },
  });

  return { url: checkout.url, amount: open };
}
