// /app/src/lib/billing/invoiceAuthoring.ts
//
// Pure math + validation for authored invoices (the composer flow). No I/O —
// the service layer (invoiceService.ts) owns Prisma. Conventions this module
// pins:
//   - line.amount is the LINE TOTAL (quantity x unitPrice), mirroring
//     OrderLineItem.netPrice.
//   - money is rounded to cents at every boundary (round2), matching the
//     half-cent tolerances used by the ledger and journal layers.
//   - invoice numbers are INV-YYMMDD-NNN (imported legacy invoices keep their
//     source numbering; the INV prefix cannot collide with it).

import { assertBalanced, type JournalLine } from "@/lib/journalEntry";

export interface DraftLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceTotals {
  /** Per-line amounts in input order, rounded to cents. */
  lineAmounts: number[];
  subtotal: number;
  taxAmount: number;
  total: number;
}

export class InvoiceValidationError extends Error {}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Validate composer lines and compute totals. taxRate is a fraction
 * (0.0635 = 6.35%); consulting invoices typically pass 0.
 */
export function computeInvoiceTotals(
  lines: readonly DraftLineInput[],
  taxRate: number = 0,
): InvoiceTotals {
  if (lines.length === 0) {
    throw new InvoiceValidationError("An invoice needs at least one line");
  }
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate >= 1) {
    throw new InvoiceValidationError("Tax rate must be a fraction between 0 and 1");
  }
  const lineAmounts: number[] = [];
  let subtotal = 0;
  for (const [i, line] of lines.entries()) {
    if (!line.description || line.description.trim().length === 0) {
      throw new InvoiceValidationError(`Line ${i + 1} needs a description`);
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new InvoiceValidationError(`Line ${i + 1}: quantity must be positive`);
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      throw new InvoiceValidationError(`Line ${i + 1}: unit price cannot be negative`);
    }
    const amount = round2(line.quantity * line.unitPrice);
    lineAmounts.push(amount);
    subtotal = round2(subtotal + amount);
  }
  const taxAmount = round2(subtotal * taxRate);
  const total = round2(subtotal + taxAmount);
  if (total <= 0) {
    throw new InvoiceValidationError("Invoice total must be positive");
  }
  return { lineAmounts, subtotal, taxAmount, total };
}

/** INV-YYMMDD-NNN, sequence within the day. */
export function formatInvoiceNumber(date: Date, seq: number): string {
  const yy = date.getFullYear().toString().slice(-2);
  const mm = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");
  return `INV-${yy}${mm}${dd}-${seq.toString().padStart(3, "0")}`;
}

/** Parse the trailing sequence from an INV-YYMMDD-NNN number; null if not ours. */
export function parseInvoiceSequence(invoiceNo: string, prefix: string): number | null {
  if (!invoiceNo.startsWith(prefix)) return null;
  const seq = Number.parseInt(invoiceNo.slice(prefix.length), 10);
  return Number.isNaN(seq) ? null : seq;
}

export type InvoiceAction = "edit" | "delete" | "issue" | "void" | "record-payment" | "email";

/**
 * Status guard for every mutation on an authored invoice. DRAFT is the only
 * editable state; ISSUED accepts payments/void/email; PAID and VOID are
 * terminal. Returns an error message, or null when the action is allowed.
 */
export function invoiceActionError(status: string, action: InvoiceAction): string | null {
  switch (action) {
    case "edit":
    case "delete":
      return status === "DRAFT" ? null : `Only DRAFT invoices can be ${action}ed`;
    case "issue":
      return status === "DRAFT" ? null : "Only DRAFT invoices can be issued";
    case "void":
      return status === "DRAFT" || status === "ISSUED"
        ? null
        : "Only DRAFT or ISSUED invoices can be voided";
    case "record-payment":
      return status === "ISSUED" ? null : "Payments can only be recorded on ISSUED invoices";
    case "email":
      return status === "ISSUED" || status === "PAID"
        ? null
        : "Only issued invoices can be emailed";
    default:
      return "Unknown action";
  }
}

export interface IssuanceJournalInput {
  invoiceNo: string;
  subtotal: number;
  taxAmount: number;
  arGlAccountId: number;
  revenueGlAccountId: number;
  /** Required when taxAmount > 0. */
  taxGlAccountId: number | null;
}

/**
 * Journal lines for AR recognition at issuance: debit AR control for the
 * total, credit revenue for the subtotal, credit tax liability for the tax.
 * Throws if the result would be unbalanced (defense in depth — the DB
 * constraint would also reject it).
 */
export function buildIssuanceJournalLines(input: IssuanceJournalInput): JournalLine[] {
  const total = round2(input.subtotal + input.taxAmount);
  if (input.taxAmount > 0 && input.taxGlAccountId === null) {
    throw new InvoiceValidationError(
      "A Sales Tax GL mapping is required to issue an invoice with tax",
    );
  }
  const lines: JournalLine[] = [
    {
      glAccountId: input.arGlAccountId,
      memo: `AR - invoice ${input.invoiceNo}`,
      debit: total,
      credit: 0,
      sortOrder: 10,
    },
    {
      glAccountId: input.revenueGlAccountId,
      memo: `Revenue - invoice ${input.invoiceNo}`,
      debit: 0,
      credit: input.subtotal,
      sortOrder: 20,
    },
  ];
  if (input.taxAmount > 0 && input.taxGlAccountId !== null) {
    lines.push({
      glAccountId: input.taxGlAccountId,
      memo: `Sales tax - invoice ${input.invoiceNo}`,
      debit: 0,
      credit: input.taxAmount,
      sortOrder: 30,
    });
  }
  const balance = assertBalanced(lines);
  if (!balance.ok) {
    throw new InvoiceValidationError(balance.error ?? "Issuance journal is out of balance");
  }
  return lines;
}

export interface PaymentJournalInput {
  invoiceNo: string;
  amount: number;
  cashGlAccountId: number;
  arGlAccountId: number;
}

/** Journal lines for an invoice payment: debit cash, credit AR control. */
export function buildInvoicePaymentJournalLines(input: PaymentJournalInput): JournalLine[] {
  const amount = round2(input.amount);
  if (amount <= 0) {
    throw new InvoiceValidationError("Payment amount must be positive");
  }
  const lines: JournalLine[] = [
    {
      glAccountId: input.cashGlAccountId,
      memo: `Payment - invoice ${input.invoiceNo}`,
      debit: amount,
      credit: 0,
      sortOrder: 10,
    },
    {
      glAccountId: input.arGlAccountId,
      memo: `AR relief - invoice ${input.invoiceNo}`,
      debit: 0,
      credit: amount,
      sortOrder: 20,
    },
  ];
  const balance = assertBalanced(lines);
  if (!balance.ok) {
    throw new InvoiceValidationError(balance.error ?? "Payment journal is out of balance");
  }
  return lines;
}

/**
 * Source-side balance contribution of authored (standalone) invoices for the
 * AR drift check: total of every ISSUED/PAID invoice minus its applied
 * payments. Mirrors how the ledger sees the same events (SALE at issuance,
 * PAYMENT on completion — applications equal payment amounts by construction
 * in the invoice flow). DRAFT and VOID invoices contribute nothing.
 */
export function computeStandaloneInvoiceSource(
  invoices: ReadonlyArray<{
    status: string;
    total: number;
    appliedAmounts: ReadonlyArray<number>;
  }>,
): number {
  let balance = 0;
  for (const inv of invoices) {
    if (inv.status !== "ISSUED" && inv.status !== "PAID") continue;
    let applied = 0;
    for (const a of inv.appliedAmounts) applied += a;
    balance += inv.total - applied;
  }
  return round2(balance);
}
