// /app/__tests__/integration/booksReconcile.integration.test.ts
//
// Books-wide reconcile proof (#141). invoiceLifecycle.integration.test.ts pins
// the per-invoice mechanics; this asserts the three invariants that have to hold
// across the WHOLE ledger after a realistic mix of issue / partial-pay / full-pay
// / void, for multiple customers:
//
//   1. Trial balance — Σ all journal debits == Σ all journal credits.
//   2. AR control tie-out — the AR GL account's net (debits − credits) ==
//      Σ customer.openArBalance == Σ customer-ledger running balances.
//   3. AR == open receivables — Σ openArBalance == Σ over ISSUED invoices of
//      (total − applied). PAID and VOID invoices contribute nothing.
//
// These are the "is it safe to take money?" books checks: if the application
// ever posts an unbalanced journal or lets the subledger drift from the GL, one
// of these fails. Real SQL, no mocked Prisma.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  createDraftInvoice,
  issueInvoice,
  recordInvoicePayment,
  voidInvoice,
} from "@/lib/billing/invoiceService";
import { computeRunningBalance } from "@/lib/customerLedger";

async function seedOrgAndGl() {
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
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

function makeCustomer(firstName: string) {
  return prisma.customer.create({ data: { firstName, lastName: "Recon" } });
}

async function issuedInvoice(customerId: number, unitPrice: number, taxRate = 0) {
  const { id } = await createDraftInvoice({
    customerId,
    lines: [{ description: "Work", quantity: 1, unitPrice }],
    taxRate,
  });
  await issueInvoice(id);
  return id;
}

describe("books-wide reconcile against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ties out across issue / partial-pay / full-pay / void for many customers", async () => {
    const { ar } = await seedOrgAndGl();

    // A — $1000, partial $400 paid → open 600.
    const a = await makeCustomer("A");
    const invA = await issuedInvoice(a.id, 1000);
    await recordInvoicePayment(invA, { amount: 400, method: "CHECK" });

    // B — $500 + 10% tax = $550, paid in full → open 0, PAID.
    const b = await makeCustomer("B");
    const invB = await issuedInvoice(b.id, 500, 0.1);
    await recordInvoicePayment(invB, { amount: 550, method: "CHECK" });

    // C — $750, issued then voided → open 0, VOID.
    const c = await makeCustomer("C");
    const invC = await issuedInvoice(c.id, 750);
    await voidInvoice(invC);

    // D — $1200, issued, no payment → open 1200.
    const d = await makeCustomer("D");
    await issuedInvoice(d.id, 1200);

    const EXPECTED_AR = 1800; // 600 (A) + 0 (B) + 0 (C) + 1200 (D)

    // ---- Invariant 1: trial balance over the entire ledger ----
    const allLines = await prisma.journalEntryLine.findMany({
      select: { debit: true, credit: true, glAccountId: true },
    });
    const totalDebits = allLines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredits = allLines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebits).toBeGreaterThan(0);
    expect(round2(totalDebits)).toBe(round2(totalCredits));

    // ---- Invariant 2: AR control == subledger ----
    const arNet = allLines
      .filter((l) => l.glAccountId === ar.id)
      .reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(round2(arNet)).toBe(EXPECTED_AR);

    const customers = await prisma.customer.findMany({
      where: { id: { in: [a.id, b.id, c.id, d.id] } },
      select: { id: true, openArBalance: true },
    });
    const sumOpenAr = customers.reduce((s, cu) => s + Number(cu.openArBalance), 0);
    expect(round2(sumOpenAr)).toBe(EXPECTED_AR);

    // Each customer's stored openArBalance must equal their ledger replayed from
    // scratch (the daily-drift-check invariant, asserted per customer here).
    for (const cu of customers) {
      const entries = await prisma.customerLedgerEntry.findMany({
        where: { customerId: cu.id },
        orderBy: { id: "asc" },
        select: { amount: true },
      });
      const { balance } = computeRunningBalance(entries.map((e) => ({ amount: Number(e.amount) })));
      expect(round2(balance)).toBe(round2(Number(cu.openArBalance)));
    }

    // ---- Invariant 3: AR == open receivables on ISSUED invoices ----
    const issued = await prisma.invoice.findMany({
      where: { status: "ISSUED" },
      select: { id: true, total: true, applications: { select: { amountApplied: true } } },
    });
    const openReceivables = issued.reduce((s, inv) => {
      const applied = inv.applications.reduce((a, ap) => a + Number(ap.amountApplied), 0);
      return s + (Number(inv.total ?? 0) - applied);
    }, 0);
    expect(round2(openReceivables)).toBe(EXPECTED_AR);

    // Sanity: PAID/VOID invoices exist but contribute nothing to AR.
    expect(await prisma.invoice.count({ where: { status: "PAID" } })).toBe(1);
    expect(await prisma.invoice.count({ where: { status: "VOID" } })).toBe(1);
  });
});

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
