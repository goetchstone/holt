// /app/src/pages/api/client-portal/pay.ts
//
// POST — public, token-authed: create a Stripe checkout link for one of the
// token-holder's OWN invoices. The capability token scopes the customer; the
// invoice must belong to that customer, or the request is refused — a portal
// link can never pay someone else's invoice. Rate-limited like every portal
// route. 404 when the clientPortal feature is off. 409 while a checkout on the
// invoice may still be open; a `force` retry voids it and starts a new one,
// safe for the same reason as portal/pay: the token scopes it to the
// customer's own invoice.

import type { NextApiRequest, NextApiResponse } from "next";
import { rateLimit } from "@/lib/rateLimit";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { verifyClientPortalToken } from "@/lib/clientPortalToken";
import { createInvoicePaymentLink } from "@/lib/billing/invoiceStripe";
import { InvoiceValidationError } from "@/lib/billing/invoiceAuthoring";
import { CheckoutAlreadyOpenError } from "@/lib/paymentService";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  if (!(await isModuleEnabled("clientPortal"))) {
    return res.status(404).json({ error: "Not found" });
  }

  const { token, invoiceId, force } = req.body as {
    token?: string;
    invoiceId?: number;
    /** Void an already-open PENDING checkout on this invoice and replace it. */
    force?: boolean;
  };
  if (!token || typeof invoiceId !== "number") {
    return res.status(400).json({ error: "token and invoiceId are required" });
  }
  const payload = verifyClientPortalToken(token);
  if (!payload) {
    return res.status(401).json({ error: "This portal link has expired" });
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { customerId: true },
  });
  if (!invoice || invoice.customerId !== payload.customerId) {
    return res.status(404).json({ error: "Invoice not found" });
  }

  try {
    const link = await createInvoicePaymentLink(invoiceId, "client-portal", {
      force: force === true,
    });
    return res.status(200).json({ url: link.url, amount: link.amount });
  } catch (err) {
    if (err instanceof InvoiceValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof CheckoutAlreadyOpenError) {
      const open = err.existing;
      return res.status(409).json({
        error:
          `A payment of $${open.amount.toFixed(2)} is already in progress on ` +
          `this invoice (started ${open.ageMinutes} min ago). If that attempt ` +
          `failed, retry with force:true to start a new one.`,
        existingPayment: open,
      });
    }
    logError("Client portal pay-link creation failed", err);
    return res.status(500).json({ error: "Could not start the payment" });
  }
}

export default rateLimit({ windowMs: 60_000, maxRequests: 10 })(handler);
