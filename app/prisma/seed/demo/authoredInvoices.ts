// /app/prisma/seed/demo/authoredInvoices.ts
//
// One authored invoice still in DRAFT, with its lines: design fees for a
// consultation, written in the invoice composer and not yet sent. It gives
// Sales > Invoices a draft to open, edit and issue, and the invoice detail page
// an invoice with lines (docs/testing/page-sweep.md). The seeded order invoices
// carry no lines (salesOrders.ts).
//
// Made through createDraftInvoice (lib/billing/invoiceService.ts), the
// composer's own path, which writes the Invoice and its InvoiceLineItems and
// nothing else. It is never issued here: issuing posts a journal and appends a
// CustomerLedgerEntry, and the seed leaves the AR ledger out on purpose
// (docs/domains/seed-data.md, "What was deliberately left out").
//
// The invoice's number and date come from the wall clock, as the composer's do,
// so they differ between runs on different days. No RNG draws.

import { createDraftInvoice } from "@/lib/billing/invoiceService";

const SEED_ACTOR = "seed:demo";
const DAY_MS = 86_400_000;

export async function seedAuthoredInvoices(customerId: number): Promise<{ id: number }> {
  return createDraftInvoice({
    customerId,
    lines: [
      // The seeded consultation's price (scheduling.ts).
      { description: "In-home design consultation (90 minutes)", quantity: 1, unitPrice: 150 },
      {
        description: "Space plan and furniture layout: living and dining rooms",
        quantity: 1,
        unitPrice: 325,
      },
      { description: "Window measure for custom drapery", quantity: 1, unitPrice: 75 },
    ],
    taxRate: 0,
    dueDate: new Date(Date.now() + 30 * DAY_MS),
    notes: "Design fees are credited toward a furniture order placed within 60 days.",
    createdBy: SEED_ACTOR,
  });
}
