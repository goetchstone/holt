// /app/src/lib/billing/invoiceStripe.ts
//
// Stripe checkout for authored invoices. Mirrors the order payment-link flow
// (pages/api/stripe/send-payment-link.ts): create a checkout session for the
// open balance, store a PENDING customer-linked Payment keyed by session id.
// The webhook completes it (completePayment -> ledger) and then
// applyInvoiceStripePayment adds the application + AR_PAYMENT journal.
// Server-only (imports the Stripe client).

import { prisma } from "@/lib/prisma";
import { getStripe, resolveCheckoutEmail } from "@/lib/stripe";
import { getAppSettings } from "@/lib/appSettings";
import { InvoiceValidationError, invoiceActionError } from "@/lib/billing/invoiceAuthoring";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface InvoicePaymentLink {
  url: string;
  amount: number;
}

export async function createInvoicePaymentLink(
  invoiceId: number,
  requestedBy?: string | null,
): Promise<InvoicePaymentLink> {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      invoiceNo: true,
      status: true,
      total: true,
      customerId: true,
      organizationId: true,
      customer: { select: { email: true, firstName: true, lastName: true } },
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
  const stripe = await getStripe();
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: (settings.currency || "USD").toLowerCase(),
          product_data: {
            name: `Invoice ${invoice.invoiceNo} — ${settings.companyName || settings.appName}`,
          },
          unit_amount: Math.round(open * 100),
        },
        quantity: 1,
      },
    ],
    customer_email: resolveCheckoutEmail(invoice.customer.email),
    metadata: {
      invoiceId: String(invoiceId),
      invoiceNo: invoice.invoiceNo,
      requestedBy: requestedBy ?? "",
    },
    success_url: `${baseUrl}/app/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/app/payment/cancel?invoice_id=${invoiceId}`,
  });

  if (!session.url) {
    throw new InvoiceValidationError("Stripe did not return a checkout URL");
  }

  await prisma.payment.create({
    data: {
      paymentDate: new Date(),
      paymentType: "Card",
      paymentAmount: open,
      status: "PENDING",
      method: "CARD",
      customerId: invoice.customerId,
      // Structural binding — the webhook routes on this, never on metadata.
      invoiceId,
      processorType: "STRIPE",
      processorTxnId: session.id,
      createdBy: requestedBy ?? null,
    },
  });

  return { url: session.url, amount: open };
}
