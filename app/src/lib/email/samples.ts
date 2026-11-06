// /app/src/lib/email/samples.ts
//
// One invented example of each email, for the preview at Admin > Setup > Email look and
// wording (GAP-37). It runs the real templates, so what a store sees is what goes out.

import type { EmailLook } from "./look";
import {
  bookingConfirmationEmail,
  customerMessageEmail,
  followUpEmail,
  invoiceIssuedEmail,
  lowStockEmail,
  passwordResetEmail,
  purchaseOrderEmail,
  ticketReceivedEmail,
  ticketReplyEmail,
  type EmailChrome,
  type RenderedEmail,
} from "./templates";
import type { EmailKind } from "./wordingCatalog";

const EXAMPLE_URL = "https://example.com";

export function sampleEmail(kind: EmailKind, store: string, chrome: EmailChrome): RenderedEmail {
  switch (kind) {
    case "follow-up":
      return followUpEmail({
        chrome,
        storeName: store,
        staffName: "Pat",
        baseUrl: EXAMPLE_URL,
        due: [{ name: "Sam Rivera", detail: "due Tuesday, 555-0100" }],
        quotesWaiting: 2,
        suggested: [{ name: "Alex Chen", detail: "$12,400 lifetime, last order March 2025" }],
        suggestedCount: 1,
        suggestedWhy: "Past clients who have gone quiet.",
      }) as RenderedEmail;
    case "low-stock":
      return lowStockEmail({
        chrome,
        storeName: store,
        url: `${EXAMPLE_URL}/app/purchasing/low-stock`,
        rows: [
          {
            store: "Main Street",
            productName: "Oak side table",
            free: 1,
            onOrder: 0,
            minQuantity: 3,
            suggested: 2,
          },
        ],
      });
    case "booking":
      return bookingConfirmationEmail({
        chrome,
        appName: store,
        customerName: "Sam",
        serviceName: "design consultation",
        startsAt: new Date("2026-03-10T15:00:00Z"),
        timezone: "UTC",
      });
    case "ticket-received":
      return ticketReceivedEmail({
        chrome,
        appName: store,
        submitterName: "Sam",
        ticketNumber: "TKT-1042",
        subject: "A question about my delivery",
        statusUrl: `${EXAMPLE_URL}/support/example`,
      });
    case "ticket-reply":
      return ticketReplyEmail({
        chrome,
        appName: store,
        submitterName: "Sam",
        ticketNumber: "TKT-1042",
        subject: "",
        statusUrl: `${EXAMPLE_URL}/support/example`,
        messageBody: "Your delivery is on the truck for Thursday.",
      });
    case "invoice":
      return invoiceIssuedEmail({
        chrome,
        appName: store,
        customerName: "Sam Rivera",
        invoiceNo: "INV-1042",
        totalFormatted: "$1,250.00",
        openBalanceFormatted: "$1,250.00",
        dueDate: new Date("2026-03-31T12:00:00Z"),
        paymentUrl: `${EXAMPLE_URL}/pay`,
        lines: [{ description: "Oak side table", quantity: 2, amountFormatted: "$1,250.00" }],
      });
    case "password-reset":
      return passwordResetEmail({
        chrome,
        appName: store,
        displayName: "Pat",
        resetUrl: `${EXAMPLE_URL}/auth/reset-password`,
      });
    case "purchase-order":
      return purchaseOrderEmail({
        chrome,
        companyName: store,
        vendorName: "Fernbrook Upholstery",
        poNumber: "PO-1042",
        message: "Please ship these together.",
      });
  }
}

/** A customer message's look, which has its own wording screen. */
export function sampleCustomerMessage(store: string, look: EmailLook): RenderedEmail {
  return customerMessageEmail({
    look,
    storeName: store,
    subject: "Your furniture has arrived",
    text: "Hi Sam,\n\nYour oak side table has arrived. We'll be in touch about delivery.",
    links: [{ label: "View your order", url: `${EXAMPLE_URL}/portal/order` }],
  });
}
