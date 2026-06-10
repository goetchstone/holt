// /app/src/lib/billing/invoiceService.ts
//
// Authored-invoice lifecycle: draft -> issue -> pay/void. The accounting
// contract (see docs/domains/accounts-receivable.md):
//
//   ISSUE   posts the AR_SALE journal (debit AR control, credit revenue +
//           tax), appends a SALE ledger entry (+total), stamps issuedAt.
//   PAYMENT creates a COMPLETED Payment (customer-linked, no sales order),
//           a PaymentApplication for the same amount, an AR_PAYMENT journal
//           (debit cash/card GL, credit AR control), and a PAYMENT ledger
//           entry (-amount) — Stripe payments do the ledger half through
//           completePayment, then applyInvoiceStripePayment adds the rest.
//   VOID    of an ISSUED invoice posts the reversing journal and an
//           ADJUSTMENT_CREDIT ledger entry; refused once payments exist.
//
// Applications always equal their payment amounts (enforced at creation), so
// the customer ledger, the open-item view, and the AR drift check agree by
// construction. Journal numbers are ARI-/ARP-/ARV-<invoiceNo> — unique, so a
// retried webhook can never double-post.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendEntry } from "@/lib/customerLedger";
import { isValidApplication } from "@/lib/arEngine";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import {
  computeInvoiceTotals,
  formatInvoiceNumber,
  invoiceActionError,
  buildIssuanceJournalLines,
  buildInvoicePaymentJournalLines,
  InvoiceValidationError,
  type DraftLineInput,
} from "@/lib/billing/invoiceAuthoring";
import type { JournalLine } from "@/lib/journalEntry";

type Tx = Prisma.TransactionClient;

const PAID_TOLERANCE = 0.005;

// Display labels for manual invoice payments. Must match the POS_PAYMENTS
// SystemGLMapping labels (case-insensitive) so the AR_PAYMENT journal can
// resolve a cash-side GL account.
const INVOICE_PAYMENT_LABELS: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  WIRE: "Wire",
  ACH: "ACH",
  OTHER: "Other",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CreateDraftInput {
  customerId: number;
  lines: DraftLineInput[];
  taxRate?: number;
  dueDate?: Date | null;
  notes?: string | null;
  createdBy?: string | null;
}

export interface InvoiceSummary {
  id: number;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  customerId: number | null;
  customerName: string;
  total: number;
  taxAmount: number;
  openBalance: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  notes: string | null;
  issuedAt: string | null;
  subtotal: number;
  lines: {
    id: number;
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }[];
  payments: {
    paymentId: number;
    paymentDate: string;
    paymentType: string;
    amountApplied: number;
    status: string | null;
  }[];
  customerEmail: string | null;
}

function customerLabel(c: { firstName: string | null; lastName: string | null } | null): string {
  if (!c) return "(no customer)";
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "(unnamed)";
}

/** total - sum of applications. Authored invoices always have total set. */
function openBalanceOf(
  total: number,
  applications: ReadonlyArray<{ amountApplied: Prisma.Decimal }>,
): number {
  let applied = 0;
  for (const a of applications) applied += Number(a.amountApplied);
  return round2(total - applied);
}

async function nextInvoiceNumber(tx: Tx, date: Date): Promise<string> {
  const probe = formatInvoiceNumber(date, 1);
  const prefix = probe.slice(0, probe.lastIndexOf("-") + 1);
  const last = await tx.invoice.findFirst({
    where: { invoiceNo: { startsWith: prefix } },
    orderBy: { invoiceNo: "desc" },
    select: { invoiceNo: true },
  });
  let seq = 1;
  if (last) {
    const lastSeq = Number.parseInt(last.invoiceNo.slice(prefix.length), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return formatInvoiceNumber(date, seq);
}

interface ArGlMappings {
  arGlAccountId: number;
  revenueGlAccountId: number;
  taxGlAccountId: number | null;
}

/**
 * Resolve the GL accounts the invoice journals post to. Configured in
 * Admin -> Setup -> Accounting -> System Mappings:
 *   AR_TRANSACTIONS / "Accounts Receivable"  (AR control, required)
 *   AR_TRANSACTIONS / "Invoice Sales"        (revenue, required)
 *   AR_TRANSACTIONS / "Sales Tax"            (falls back to POS_TRANSACTIONS)
 * Issuance refuses with an instructive error rather than posting to nowhere.
 */
async function resolveArGlMappings(tx: Tx): Promise<ArGlMappings> {
  const [ar, revenue, arTax, posTax] = await Promise.all([
    tx.systemGLMapping.findUnique({
      where: { section_label: { section: "AR_TRANSACTIONS", label: "Accounts Receivable" } },
      select: { glAccountId: true },
    }),
    tx.systemGLMapping.findUnique({
      where: { section_label: { section: "AR_TRANSACTIONS", label: "Invoice Sales" } },
      select: { glAccountId: true },
    }),
    tx.systemGLMapping.findUnique({
      where: { section_label: { section: "AR_TRANSACTIONS", label: "Sales Tax" } },
      select: { glAccountId: true },
    }),
    tx.systemGLMapping.findUnique({
      where: { section_label: { section: "POS_TRANSACTIONS", label: "Sales Tax" } },
      select: { glAccountId: true },
    }),
  ]);
  if (!ar?.glAccountId || !revenue?.glAccountId) {
    throw new InvoiceValidationError(
      'Invoice GL mappings are not configured. In Admin -> Setup -> Accounting, map "Accounts Receivable" and "Invoice Sales" under the AR Transactions section.',
    );
  }
  return {
    arGlAccountId: ar.glAccountId,
    revenueGlAccountId: revenue.glAccountId,
    taxGlAccountId: arTax?.glAccountId ?? posTax?.glAccountId ?? null,
  };
}

async function postJournal(
  tx: Tx,
  input: {
    journalNumber: string;
    journalType: "AR_SALE" | "AR_PAYMENT";
    lines: JournalLine[];
    createdBy?: string | null;
  },
): Promise<void> {
  // Journal numbers encode the invoice (+ payment), so a retry of the same
  // event finds the existing entry and skips — webhook-idempotent.
  const existing = await tx.journalEntry.findUnique({
    where: { journalNumber: input.journalNumber },
    select: { id: true },
  });
  if (existing) return;
  let totalDebits = 0;
  let totalCredits = 0;
  for (const l of input.lines) {
    totalDebits = round2(totalDebits + l.debit);
    totalCredits = round2(totalCredits + l.credit);
  }
  await tx.journalEntry.create({
    data: {
      journalNumber: input.journalNumber,
      journalDate: new Date(),
      journalType: input.journalType,
      status: "POSTED",
      totalDebits,
      totalCredits,
      createdBy: input.createdBy ?? null,
      lines: {
        create: input.lines.map((l) => ({
          glAccountId: l.glAccountId,
          memo: l.memo,
          debit: l.debit,
          credit: l.credit,
          sortOrder: l.sortOrder,
        })),
      },
    },
  });
}

export async function createDraftInvoice(input: CreateDraftInput): Promise<{ id: number }> {
  const totals = computeInvoiceTotals(input.lines, input.taxRate ?? 0);
  return prisma.$transaction(async (tx) => {
    await tx.customer.findUniqueOrThrow({
      where: { id: input.customerId },
      select: { id: true },
    });
    const now = new Date();
    const invoice = await tx.invoice.create({
      data: {
        invoiceNo: await nextInvoiceNumber(tx, now),
        invoiceDate: now,
        organizationId: DEFAULT_ORG_ID,
        customerId: input.customerId,
        status: "DRAFT",
        taxAmount: totals.taxAmount,
        total: totals.total,
        dueDate: input.dueDate ?? null,
        notes: input.notes?.trim() || null,
        createdBy: input.createdBy ?? null,
        lineItems: {
          create: input.lines.map((line, i) => ({
            description: line.description.trim(),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: totals.lineAmounts[i],
            sortOrder: i,
          })),
        },
      },
      select: { id: true },
    });
    return { id: invoice.id };
  });
}

export interface UpdateDraftInput {
  lines: DraftLineInput[];
  taxRate?: number;
  customerId?: number;
  dueDate?: Date | null;
  notes?: string | null;
  updatedBy?: string | null;
}

export async function updateDraftInvoice(id: number, input: UpdateDraftInput): Promise<void> {
  const totals = computeInvoiceTotals(input.lines, input.taxRate ?? 0);
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, organizationId: true },
    });
    assertAuthored(invoice.organizationId);
    const err = invoiceActionError(invoice.status, "edit");
    if (err) throw new InvoiceValidationError(err);
    if (input.customerId !== undefined) {
      await tx.customer.findUniqueOrThrow({
        where: { id: input.customerId },
        select: { id: true },
      });
    }
    await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.update({
      where: { id },
      data: {
        taxAmount: totals.taxAmount,
        total: totals.total,
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        dueDate: input.dueDate ?? null,
        notes: input.notes?.trim() || null,
        updatedBy: input.updatedBy ?? null,
        lineItems: {
          create: input.lines.map((line, i) => ({
            description: line.description.trim(),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: totals.lineAmounts[i],
            sortOrder: i,
          })),
        },
      },
    });
  });
}

export async function deleteDraftInvoice(id: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, organizationId: true },
    });
    assertAuthored(invoice.organizationId);
    const err = invoiceActionError(invoice.status, "delete");
    if (err) throw new InvoiceValidationError(err);
    await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.delete({ where: { id } });
  });
}

/** Authored-invoice guard: the billing flow never mutates imported invoices. */
function assertAuthored(organizationId: number | null): void {
  if (organizationId === null) {
    throw new InvoiceValidationError(
      "This invoice was imported from the POS and cannot be edited here",
    );
  }
}

export async function issueInvoice(id: number, issuedBy?: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: {
        invoiceNo: true,
        status: true,
        customerId: true,
        total: true,
        taxAmount: true,
        organizationId: true,
      },
    });
    assertAuthored(invoice.organizationId);
    const err = invoiceActionError(invoice.status, "issue");
    if (err) throw new InvoiceValidationError(err);
    if (!invoice.customerId || invoice.total === null) {
      throw new InvoiceValidationError("Invoice needs a customer and a total before issuing");
    }
    const total = Number(invoice.total);
    const taxAmount = Number(invoice.taxAmount);
    const subtotal = round2(total - taxAmount);

    const gl = await resolveArGlMappings(tx);
    const lines = buildIssuanceJournalLines({
      invoiceNo: invoice.invoiceNo,
      subtotal,
      taxAmount,
      arGlAccountId: gl.arGlAccountId,
      revenueGlAccountId: gl.revenueGlAccountId,
      taxGlAccountId: gl.taxGlAccountId,
    });
    await postJournal(tx, {
      journalNumber: `ARI-${invoice.invoiceNo}`,
      journalType: "AR_SALE",
      lines,
      createdBy: issuedBy,
    });
    await appendEntry(
      {
        customerId: invoice.customerId,
        type: "SALE",
        amount: total,
        invoiceId: id,
        reference: invoice.invoiceNo,
        createdBy: issuedBy ?? undefined,
      },
      tx,
    );
    const now = new Date();
    await tx.invoice.update({
      where: { id },
      data: { status: "ISSUED", issuedAt: now, invoiceDate: now, updatedBy: issuedBy ?? null },
    });
  });
}

export async function voidInvoice(id: number, voidedBy?: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: {
        invoiceNo: true,
        status: true,
        customerId: true,
        total: true,
        taxAmount: true,
        organizationId: true,
        applications: { select: { id: true } },
      },
    });
    assertAuthored(invoice.organizationId);
    const err = invoiceActionError(invoice.status, "void");
    if (err) throw new InvoiceValidationError(err);
    if (invoice.applications.length > 0) {
      throw new InvoiceValidationError(
        "Payments have been applied to this invoice; refund them before voiding",
      );
    }
    if (invoice.status === "ISSUED" && invoice.customerId && invoice.total !== null) {
      // Reverse the issuance posting: the AR_SALE journal mirrored, and the
      // subledger backed out with an adjustment.
      const total = Number(invoice.total);
      const taxAmount = Number(invoice.taxAmount);
      const subtotal = round2(total - taxAmount);
      const gl = await resolveArGlMappings(tx);
      const issuance = buildIssuanceJournalLines({
        invoiceNo: invoice.invoiceNo,
        subtotal,
        taxAmount,
        arGlAccountId: gl.arGlAccountId,
        revenueGlAccountId: gl.revenueGlAccountId,
        taxGlAccountId: gl.taxGlAccountId,
      });
      const reversed = issuance.map((l) => ({
        ...l,
        memo: l.memo.replace("invoice", "VOID invoice"),
        debit: l.credit,
        credit: l.debit,
      }));
      await postJournal(tx, {
        journalNumber: `ARV-${invoice.invoiceNo}`,
        journalType: "AR_SALE",
        lines: reversed,
        createdBy: voidedBy,
      });
      await appendEntry(
        {
          customerId: invoice.customerId,
          type: "ADJUSTMENT_CREDIT",
          amount: -total,
          invoiceId: id,
          reference: `${invoice.invoiceNo} void`,
          createdBy: voidedBy ?? undefined,
        },
        tx,
      );
    }
    await tx.invoice.update({
      where: { id },
      data: { status: "VOID", updatedBy: voidedBy ?? null },
    });
  });
}

export interface RecordInvoicePaymentInput {
  amount: number;
  method: "CASH" | "CARD" | "CHECK" | "WIRE" | "ACH" | "OTHER";
  reference?: string | null;
  createdBy?: string | null;
}

/**
 * Record a manual (non-Stripe) payment against an ISSUED invoice. One tx:
 * COMPLETED Payment + PAYMENT ledger entry + PaymentApplication + AR_PAYMENT
 * journal + PAID flip when the open balance reaches zero.
 */
export async function recordInvoicePayment(
  id: number,
  input: RecordInvoicePaymentInput,
): Promise<{ paymentId: number; openBalance: number }> {
  const amount = round2(input.amount);
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: {
        invoiceNo: true,
        status: true,
        customerId: true,
        total: true,
        organizationId: true,
        applications: { select: { amountApplied: true } },
      },
    });
    assertAuthored(invoice.organizationId);
    const err = invoiceActionError(invoice.status, "record-payment");
    if (err) throw new InvoiceValidationError(err);
    if (!invoice.customerId || invoice.total === null) {
      throw new InvoiceValidationError("Invoice has no customer or total");
    }
    const open = openBalanceOf(Number(invoice.total), invoice.applications);
    if (!isValidApplication(new Prisma.Decimal(amount), new Prisma.Decimal(open))) {
      throw new InvoiceValidationError(
        `Payment must be between $0.01 and the open balance ($${open.toFixed(2)})`,
      );
    }

    const paymentType = INVOICE_PAYMENT_LABELS[input.method] ?? input.method;
    const cashMapping = await tx.systemGLMapping.findUnique({
      where: { section_label: { section: "POS_PAYMENTS", label: paymentType } },
      select: { glAccountId: true },
    });
    if (!cashMapping?.glAccountId) {
      throw new InvoiceValidationError(
        `No GL mapping for payment type "${paymentType}". Map it under POS Payments in Admin -> Setup -> Accounting.`,
      );
    }
    const gl = await resolveArGlMappings(tx);

    const payment = await tx.payment.create({
      data: {
        paymentDate: new Date(),
        paymentType,
        paymentAmount: amount,
        status: "COMPLETED",
        method: input.method,
        customerId: invoice.customerId,
        checkNumber: input.method === "CHECK" ? (input.reference ?? null) : null,
        createdBy: input.createdBy ?? null,
      },
      select: { id: true },
    });
    await appendEntry(
      {
        customerId: invoice.customerId,
        type: "PAYMENT",
        amount: -amount,
        paymentId: payment.id,
        invoiceId: id,
        reference: invoice.invoiceNo,
        createdBy: input.createdBy ?? undefined,
      },
      tx,
    );
    await tx.paymentApplication.create({
      data: {
        organizationId: invoice.organizationId ?? DEFAULT_ORG_ID,
        paymentId: payment.id,
        invoiceId: id,
        amountApplied: amount,
        createdBy: input.createdBy ?? null,
      },
    });
    await postJournal(tx, {
      journalNumber: `ARP-${invoice.invoiceNo}-${payment.id}`,
      journalType: "AR_PAYMENT",
      lines: buildInvoicePaymentJournalLines({
        invoiceNo: invoice.invoiceNo,
        amount,
        cashGlAccountId: cashMapping.glAccountId,
        arGlAccountId: gl.arGlAccountId,
      }),
      createdBy: input.createdBy,
    });

    const newOpen = round2(open - amount);
    if (newOpen <= PAID_TOLERANCE) {
      await tx.invoice.update({
        where: { id },
        data: { status: "PAID", updatedBy: input.createdBy ?? null },
      });
    }
    return { paymentId: payment.id, openBalance: Math.max(0, newOpen) };
  });
}

/**
 * Post-completion side effects for a Stripe invoice payment, called from the
 * webhook after completePayment() ran (payment COMPLETED + PAYMENT ledger
 * entry). Adds the PaymentApplication, the AR_PAYMENT journal, and the PAID
 * flip. Idempotent: re-fired webhooks find the existing application/journal.
 */
export async function applyInvoiceStripePayment(
  paymentId: number,
  invoiceId: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { paymentAmount: true, status: true },
    });
    if (payment.status !== "COMPLETED") return;
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: {
        invoiceNo: true,
        status: true,
        total: true,
        organizationId: true,
        applications: { select: { paymentId: true, amountApplied: true } },
      },
    });
    if (invoice.total === null) return;
    if (invoice.applications.some((a) => a.paymentId === paymentId)) return;

    const amount = round2(Number(payment.paymentAmount));
    const open = openBalanceOf(Number(invoice.total), invoice.applications);
    // The link was created for the open balance, so amount <= open in the
    // normal flow; cap defensively if a stale link pays an already-reduced
    // invoice (the surplus stays as on-account credit in the ledger).
    const applied = Math.min(amount, Math.max(0, open));
    if (applied <= 0) return;

    await tx.paymentApplication.create({
      data: {
        organizationId: invoice.organizationId ?? DEFAULT_ORG_ID,
        paymentId,
        invoiceId,
        amountApplied: applied,
      },
    });
    const gl = await resolveArGlMappings(tx);
    const cardMapping = await tx.systemGLMapping.findUnique({
      where: { section_label: { section: "POS_PAYMENTS", label: "Card" } },
      select: { glAccountId: true },
    });
    if (!cardMapping?.glAccountId) {
      throw new InvoiceValidationError(
        'No GL mapping for payment type "Card". Map it under POS Payments in Admin -> Setup -> Accounting.',
      );
    }
    await postJournal(tx, {
      journalNumber: `ARP-${invoice.invoiceNo}-${paymentId}`,
      journalType: "AR_PAYMENT",
      lines: buildInvoicePaymentJournalLines({
        invoiceNo: invoice.invoiceNo,
        amount: applied,
        cashGlAccountId: cardMapping.glAccountId,
        arGlAccountId: gl.arGlAccountId,
      }),
    });
    if (round2(open - applied) <= PAID_TOLERANCE && invoice.status === "ISSUED") {
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
    }
  });
}

export interface ListInvoicesFilter {
  status?: "DRAFT" | "ISSUED" | "PAID" | "VOID";
  customerId?: number;
}

/** Authored invoices only (organizationId set) — imported ones live on orders. */
export async function listInvoices(filter: ListInvoicesFilter): Promise<InvoiceSummary[]> {
  const rows = await prisma.invoice.findMany({
    where: {
      organizationId: { not: null },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
    },
    select: {
      id: true,
      invoiceNo: true,
      invoiceDate: true,
      dueDate: true,
      status: true,
      customerId: true,
      total: true,
      taxAmount: true,
      customer: { select: { firstName: true, lastName: true } },
      applications: { select: { amountApplied: true } },
    },
    orderBy: { id: "desc" },
    take: 500,
  });
  return rows.map((r) => {
    const total = r.total === null ? 0 : Number(r.total);
    return {
      id: r.id,
      invoiceNo: r.invoiceNo,
      invoiceDate: r.invoiceDate.toISOString(),
      dueDate: r.dueDate?.toISOString() ?? null,
      status: String(r.status),
      customerId: r.customerId,
      customerName: customerLabel(r.customer),
      total,
      taxAmount: Number(r.taxAmount),
      openBalance:
        r.status === "ISSUED" || r.status === "PAID" ? openBalanceOf(total, r.applications) : total,
    };
  });
}

export async function getInvoiceDetail(id: number): Promise<InvoiceDetail> {
  const r = await prisma.invoice.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      invoiceNo: true,
      invoiceDate: true,
      dueDate: true,
      status: true,
      customerId: true,
      organizationId: true,
      total: true,
      taxAmount: true,
      notes: true,
      issuedAt: true,
      customer: { select: { firstName: true, lastName: true, email: true } },
      lineItems: {
        orderBy: { sortOrder: "asc" },
        select: { id: true, description: true, quantity: true, unitPrice: true, amount: true },
      },
      applications: {
        select: {
          amountApplied: true,
          payment: {
            select: { id: true, paymentDate: true, paymentType: true, status: true },
          },
        },
      },
    },
  });
  assertAuthored(r.organizationId);
  const total = r.total === null ? 0 : Number(r.total);
  const taxAmount = Number(r.taxAmount);
  return {
    id: r.id,
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate.toISOString(),
    dueDate: r.dueDate?.toISOString() ?? null,
    status: String(r.status),
    customerId: r.customerId,
    customerName: customerLabel(r.customer),
    customerEmail: r.customer?.email ?? null,
    total,
    taxAmount,
    subtotal: round2(total - taxAmount),
    notes: r.notes,
    issuedAt: r.issuedAt?.toISOString() ?? null,
    openBalance:
      r.status === "ISSUED" || r.status === "PAID"
        ? openBalanceOf(
            total,
            r.applications.map((a) => ({ amountApplied: a.amountApplied })),
          )
        : total,
    lines: r.lineItems.map((l) => ({
      id: l.id,
      description: l.description ?? "",
      quantity: l.quantity === null ? 0 : Number(l.quantity),
      unitPrice: l.unitPrice === null ? 0 : Number(l.unitPrice),
      amount: l.amount === null ? 0 : Number(l.amount),
    })),
    payments: r.applications.map((a) => ({
      paymentId: a.payment.id,
      paymentDate: a.payment.paymentDate.toISOString(),
      paymentType: a.payment.paymentType,
      amountApplied: Number(a.amountApplied),
      status: a.payment.status ? String(a.payment.status) : null,
    })),
  };
}
