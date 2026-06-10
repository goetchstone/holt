// /app/__tests__/integration/invoiceLifecycle.integration.test.ts
//
// Real-DB proof of the authored-invoice lifecycle: draft -> issue (AR_SALE
// journal + SALE ledger entry + openArBalance bump) -> record payment
// (application + AR_PAYMENT journal + PAYMENT ledger entry + PAID flip) ->
// the AR drift check ties out. Plus the void reversal and the guard rails
// (no GL mappings configured, editing an issued invoice). Money code — real
// SQL, no mocked Prisma.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  createDraftInvoice,
  updateDraftInvoice,
  issueInvoice,
  voidInvoice,
  recordInvoicePayment,
  getInvoiceDetail,
} from "@/lib/billing/invoiceService";
import { runCustomerArDriftCheck } from "@/lib/customerArDriftRunner";

async function seedOrgAndGl() {
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  const ar = await prisma.gLAccount.create({
    data: { code: "1-1100", name: "Accounts Receivable", accountType: "ASSET" },
  });
  const revenue = await prisma.gLAccount.create({
    data: { code: "4-4000", name: "Service Revenue", accountType: "REVENUE" },
  });
  const tax = await prisma.gLAccount.create({
    data: { code: "2-2120", name: "Sales Tax Payable", accountType: "LIABILITY" },
  });
  const cash = await prisma.gLAccount.create({
    data: { code: "1-1006", name: "Cash", accountType: "ASSET" },
  });
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: ar.id },
      { section: "AR_TRANSACTIONS", label: "Invoice Sales", glAccountId: revenue.id },
      { section: "AR_TRANSACTIONS", label: "Sales Tax", glAccountId: tax.id },
      { section: "POS_PAYMENTS", label: "Check", glAccountId: cash.id },
      { section: "POS_PAYMENTS", label: "Card", glAccountId: cash.id },
    ],
  });
  return { ar, revenue, tax, cash };
}

async function makeCustomer(firstName: string) {
  return prisma.customer.create({ data: { firstName, lastName: "Test" } });
}

describe("invoice lifecycle against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("draft -> issue posts a balanced AR_SALE journal + SALE ledger entry", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Issue");

    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [
        { description: "Consulting - June", quantity: 10, unitPrice: 150 },
        { description: "Hosting", quantity: 1, unitPrice: 100 },
      ],
      taxRate: 0.0635,
      createdBy: "test@holt",
    });

    const draft = await getInvoiceDetail(id);
    expect(draft.status).toBe("DRAFT");
    expect(draft.subtotal).toBe(1600);
    expect(draft.taxAmount).toBe(101.6);
    expect(draft.total).toBe(1701.6);
    expect(draft.invoiceNo).toMatch(/^INV-\d{6}-\d{3}$/);

    await issueInvoice(id, "test@holt");

    const issued = await getInvoiceDetail(id);
    expect(issued.status).toBe("ISSUED");
    expect(issued.issuedAt).not.toBeNull();

    // Journal: ARI-<no>, POSTED, balanced, debit AR total / credit rev + tax.
    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { journalNumber: `ARI-${issued.invoiceNo}` },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    expect(je.journalType).toBe("AR_SALE");
    expect(je.status).toBe("POSTED");
    expect(Number(je.totalDebits)).toBe(1701.6);
    expect(Number(je.totalCredits)).toBe(1701.6);
    expect(je.lines).toHaveLength(3);
    expect(Number(je.lines[0].debit)).toBe(1701.6);
    expect(Number(je.lines[1].credit)).toBe(1600);
    expect(Number(je.lines[2].credit)).toBe(101.6);

    // Subledger: SALE entry + running balance on the customer.
    const ledger = await prisma.customerLedgerEntry.findMany({
      where: { customerId: cust.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("SALE");
    expect(Number(ledger[0].amount)).toBe(1701.6);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } });
    expect(Number(customer.openArBalance)).toBe(1701.6);

    // Issued invoices are frozen.
    await expect(
      updateDraftInvoice(id, {
        lines: [{ description: "x", quantity: 1, unitPrice: 1 }],
      }),
    ).rejects.toThrow("Only DRAFT");
  });

  it("recording payments applies, posts AR_PAYMENT journals, flips PAID, and ties out in the drift check", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Pay");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Retainer", quantity: 1, unitPrice: 1000 }],
    });
    await issueInvoice(id);

    // Partial payment.
    const first = await recordInvoicePayment(id, { amount: 400, method: "CHECK" });
    expect(first.openBalance).toBe(600);
    let detail = await getInvoiceDetail(id);
    expect(detail.status).toBe("ISSUED");
    expect(detail.openBalance).toBe(600);

    // Overpayment refused.
    await expect(recordInvoicePayment(id, { amount: 600.01, method: "CASH" })).rejects.toThrow(
      "open balance",
    );

    // Closing payment.
    const second = await recordInvoicePayment(id, { amount: 600, method: "CHECK" });
    expect(second.openBalance).toBe(0);
    detail = await getInvoiceDetail(id);
    expect(detail.status).toBe("PAID");
    expect(detail.payments).toHaveLength(2);

    // Each payment posted its own balanced AR_PAYMENT journal.
    const journals = await prisma.journalEntry.findMany({
      where: { journalType: "AR_PAYMENT" },
      include: { lines: true },
    });
    expect(journals).toHaveLength(2);
    for (const j of journals) {
      expect(Number(j.totalDebits)).toBe(Number(j.totalCredits));
      expect(j.status).toBe("POSTED");
    }

    // Customer balance back to zero; ledger holds SALE + 2 PAYMENTs.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } });
    expect(Number(customer.openArBalance)).toBe(0);

    // The AR drift check sees the standalone invoice on the source side and
    // reports the customer clean — the regression this feature could have
    // introduced (ledger says 0/1000, order-only source says nothing).
    const report = await runCustomerArDriftCheck({ customerIds: [cust.id] });
    expect(report.checked).toBe(1);
    expect(report.ok).toBe(1);
    expect(report.drifted).toHaveLength(0);
  });

  it("voiding an issued invoice reverses the journal and the ledger", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Void");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Cancelled work", quantity: 1, unitPrice: 750 }],
    });
    await issueInvoice(id);
    await voidInvoice(id, "test@holt");

    const detail = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(detail.status).toBe("VOID");

    const reversal = await prisma.journalEntry.findUniqueOrThrow({
      where: { journalNumber: `ARV-${detail.invoiceNo}` },
      include: { lines: true },
    });
    // Mirrored: AR credited, revenue debited.
    expect(Number(reversal.lines[0].credit)).toBe(750);
    expect(Number(reversal.totalDebits)).toBe(Number(reversal.totalCredits));

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } });
    expect(Number(customer.openArBalance)).toBe(0);

    // And it still ties out in the drift check (VOID contributes nothing).
    const report = await runCustomerArDriftCheck({ customerIds: [cust.id] });
    expect(report.ok).toBe(1);
  });

  it("void refuses once payments are applied", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Guard");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    });
    await issueInvoice(id);
    await recordInvoicePayment(id, { amount: 50, method: "CHECK" });
    await expect(voidInvoice(id)).rejects.toThrow("refund them before voiding");
  });

  it("issue refuses with an instructive error when AR GL mappings are missing", async () => {
    await prisma.organization.create({ data: { name: "Bare Co", slug: "bare-co" } });
    const cust = await makeCustomer("NoGl");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    });
    await expect(issueInvoice(id)).rejects.toThrow("AR Transactions");
    // Nothing posted: no journal, no ledger entry, still DRAFT.
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(inv.status).toBe("DRAFT");
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.customerLedgerEntry.count()).toBe(0);
  });

  it("manual payment refuses when the cash GL mapping for the method is missing", async () => {
    await seedOrgAndGl();
    await prisma.systemGLMapping.deleteMany({
      where: { section: "POS_PAYMENTS", label: "Check" },
    });
    const cust = await makeCustomer("NoCash");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    });
    await issueInvoice(id);
    await expect(recordInvoicePayment(id, { amount: 100, method: "CHECK" })).rejects.toThrow(
      "POS Payments",
    );
  });
});

describe("Stripe webhook path (applyInvoiceStripePayment) against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Simulates the webhook flow without the Stripe client: a PENDING payment
  // bound to the invoice (as createInvoicePaymentLink writes it), then
  // completePayment + applyInvoiceStripePayment exactly as webhook.ts calls.
  async function makeBoundPendingPayment(customerId: number, invoiceId: number, amount: number) {
    return prisma.payment.create({
      data: {
        paymentDate: new Date(),
        paymentType: "Card",
        paymentAmount: amount,
        status: "PENDING",
        method: "CARD",
        customerId,
        invoiceId,
        processorType: "STRIPE",
        processorTxnId: `cs_test_${invoiceId}_${amount}`,
      },
    });
  }

  it("completes, applies, posts the journal, flips PAID, and ties out", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Stripe");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Retainer", quantity: 1, unitPrice: 500 }],
    });
    await issueInvoice(id);

    const payment = await makeBoundPendingPayment(cust.id, id, 500);
    const { completePayment } = await import("@/lib/paymentService");
    const { applyInvoiceStripePayment } = await import("@/lib/billing/invoiceService");
    await completePayment(payment.id);
    await applyInvoiceStripePayment(payment.id, id);
    // Webhook re-fire: both steps are idempotent no-ops.
    await completePayment(payment.id);
    await applyInvoiceStripePayment(payment.id, id);

    const detail = await getInvoiceDetail(id);
    expect(detail.status).toBe("PAID");
    expect(detail.payments).toHaveLength(1);
    expect(await prisma.paymentApplication.count()).toBe(1);
    expect(await prisma.journalEntry.count({ where: { journalType: "AR_PAYMENT" } })).toBe(1);

    const report = await runCustomerArDriftCheck({ customerIds: [cust.id] });
    expect(report.ok).toBe(1);
  });

  it("overpayment: application capped at open, journal + ledger carry the FULL amount, drift ties as on-account credit", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Overpay");
    const { id } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "Work", quantity: 1, unitPrice: 1000 }],
    });
    await issueInvoice(id);
    // Manual partial payment shrinks the open balance to 600 AFTER the link
    // amount was fixed at 1000 — the stale-link overpayment shape.
    await recordInvoicePayment(id, { amount: 400, method: "CHECK" });

    const payment = await makeBoundPendingPayment(cust.id, id, 1000);
    const { completePayment } = await import("@/lib/paymentService");
    const { applyInvoiceStripePayment } = await import("@/lib/billing/invoiceService");
    await completePayment(payment.id);
    await applyInvoiceStripePayment(payment.id, id);

    // Application capped at the 600 open; invoice PAID.
    const apps = await prisma.paymentApplication.findMany({ where: { paymentId: payment.id } });
    expect(apps).toHaveLength(1);
    expect(Number(apps[0].amountApplied)).toBe(600);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(inv.status).toBe("PAID");

    // The AR_PAYMENT journal carries the FULL 1000 — mirrors the ledger entry,
    // so cash and AR don't drift apart by the 400 surplus.
    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { journalNumber: `ARP-${inv.invoiceNo}-${payment.id}` },
    });
    expect(Number(je.totalDebits)).toBe(1000);

    // Customer holds a 400 on-account credit and the drift check agrees.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } });
    expect(Number(customer.openArBalance)).toBe(-400);
    const report = await runCustomerArDriftCheck({ customerIds: [cust.id] });
    expect(report.ok).toBe(1);
    expect(report.drifted).toHaveLength(0);
  });

  it("refuses to apply when the webhook metadata invoice differs from the payment's binding", async () => {
    await seedOrgAndGl();
    const cust = await makeCustomer("Tamper");
    const { id: invoiceA } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "A", quantity: 1, unitPrice: 100 }],
    });
    const { id: invoiceB } = await createDraftInvoice({
      customerId: cust.id,
      lines: [{ description: "B", quantity: 1, unitPrice: 100 }],
    });
    await issueInvoice(invoiceA);
    await issueInvoice(invoiceB);

    const payment = await makeBoundPendingPayment(cust.id, invoiceA, 100);
    const { completePayment } = await import("@/lib/paymentService");
    const { applyInvoiceStripePayment } = await import("@/lib/billing/invoiceService");
    await completePayment(payment.id);

    await expect(applyInvoiceStripePayment(payment.id, invoiceB)).rejects.toThrow("does not match");
    expect(await prisma.paymentApplication.count()).toBe(0);
  });
});
