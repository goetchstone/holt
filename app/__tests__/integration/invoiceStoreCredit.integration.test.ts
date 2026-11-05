// /app/__tests__/integration/invoiceStoreCredit.integration.test.ts
//
// GAP-26: a customer's store credit paying their invoice, against real Postgres.
// The payment, the credit, the customer's ledger, the application and the journal
// move together or not at all, and two people can't spend the same credit twice.

import { prisma } from "@/lib/prisma";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import {
  createDraftInvoice,
  getInvoiceDetail,
  issueInvoice,
  recordInvoicePayment,
} from "@/lib/billing/invoiceService";
import { INVOICE_PAYMENT_LABELS, INVOICE_PAYMENT_METHODS } from "@/lib/billing/invoiceShared";
import { getBalance, spendStoreCreditOnInvoice, StoreCreditError } from "@/lib/customerCredit";
import { runCustomerArDriftCheck } from "@/lib/customerArDriftRunner";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";

let liability: { id: number };
let ar: { id: number };

async function makeCustomer(firstName: string, creditBalance = 0) {
  return prisma.customer.create({ data: { firstName, lastName: "Test", creditBalance } });
}

/** An issued invoice for this much, untaxed. */
async function issuedInvoice(customerId: number, amount: number) {
  const { id } = await createDraftInvoice({
    customerId,
    lines: [{ description: "Design fee", quantity: 1, unitPrice: amount }],
  });
  await issueInvoice(id, "test");
  return id;
}

const pay = (id: number, amount: number, method: "STORE_CREDIT" | "CHECK" = "STORE_CREDIT") =>
  recordInvoicePayment(id, { amount, method, createdBy: "test" });

async function counts() {
  const [payments, applications, entries, credits, journals] = await Promise.all([
    prisma.payment.count(),
    prisma.paymentApplication.count(),
    prisma.customerLedgerEntry.count({ where: { type: "PAYMENT" } }),
    prisma.customerCreditTransaction.count(),
    prisma.journalEntry.count({ where: { journalType: "AR_PAYMENT" } }),
  ]);
  return { payments, applications, entries, credits, journals };
}

const NOTHING = { payments: 0, applications: 0, entries: 0, credits: 0, journals: 0 };

beforeEach(async () => {
  await resetTestDb();
  invalidateAppSettingsCache();
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  ar = await prisma.gLAccount.create({
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
  liability = await prisma.gLAccount.create({
    data: { code: "2-2128", name: "Store Credit Liability", accountType: "LIABILITY" },
  });
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: ar.id },
      { section: "AR_TRANSACTIONS", label: "Invoice Sales", glAccountId: revenue.id },
      { section: "AR_TRANSACTIONS", label: "Sales Tax", glAccountId: tax.id },
      { section: "POS_PAYMENTS", label: "Check", glAccountId: cash.id },
      { section: "POS_PAYMENTS", label: "Store Credit", glAccountId: liability.id },
    ],
  });
});

describe("paying an invoice with store credit", () => {
  it("spends the credit and records a payment like any other", async () => {
    const customer = await makeCustomer("Ada", 300);
    const id = await issuedInvoice(customer.id, 200);

    const result = await pay(id, 200);
    expect(result.openBalance).toBe(0);
    expect(await getBalance(customer.id)).toBe(100);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId } });
    expect(payment).toMatchObject({
      method: "STORE_CREDIT",
      paymentType: "Store Credit",
      status: "COMPLETED",
      customerId: customer.id,
      invoiceId: id,
    });
    expect(Number(payment.paymentAmount)).toBe(200);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe("PAID");
  });

  it("records the spend against the payment and the invoice's number", async () => {
    const customer = await makeCustomer("Ada", 300);
    const id = await issuedInvoice(customer.id, 200);
    const { paymentId } = await pay(id, 120);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    const [txn] = await prisma.customerCreditTransaction.findMany({
      where: { customerId: customer.id },
    });
    expect(txn).toMatchObject({
      type: "USAGE",
      paymentId,
      salesOrderId: null,
      reference: invoice.invoiceNo,
      createdBy: "test",
    });
    expect(Number(txn.amount)).toBe(-120);
    expect(Number(txn.balanceBefore)).toBe(300);
    expect(Number(txn.balanceAfter)).toBe(180);
  });

  it("retires the Store Credit liability against the receivable, balanced", async () => {
    const customer = await makeCustomer("Ada", 300);
    const id = await issuedInvoice(customer.id, 200);
    await pay(id, 200);
    const journal = await prisma.journalEntry.findFirstOrThrow({
      where: { journalType: "AR_PAYMENT" },
      include: { lines: true },
    });
    const debit = journal.lines.find((l) => Number(l.debit) > 0);
    const credit = journal.lines.find((l) => Number(l.credit) > 0);
    expect(debit).toMatchObject({ glAccountId: liability.id });
    expect(Number(debit?.debit)).toBe(200);
    expect(credit).toMatchObject({ glAccountId: ar.id });
    expect(Number(credit?.credit)).toBe(200);
  });

  it("keeps the customer's receivable tied out", async () => {
    const customer = await makeCustomer("Ada", 300);
    const id = await issuedInvoice(customer.id, 200);
    await pay(id, 200);
    const report = await runCustomerArDriftCheck({ customerIds: [customer.id] });
    expect(report.drifted).toHaveLength(0);
    expect(report.ok).toBe(1);
  });

  it("can pay part, and leaves the rest open for another method", async () => {
    const customer = await makeCustomer("Ada", 50);
    const id = await issuedInvoice(customer.id, 200);
    expect((await pay(id, 50)).openBalance).toBe(150);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("ISSUED");
    expect((await pay(id, 150, "CHECK")).openBalance).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("PAID");
    expect(await getBalance(customer.id)).toBe(0);
  });

  it("another method leaves the credit alone", async () => {
    const customer = await makeCustomer("Ada", 300);
    const id = await issuedInvoice(customer.id, 200);
    await pay(id, 200, "CHECK");
    expect(await getBalance(customer.id)).toBe(300);
    expect(await prisma.customerCreditTransaction.count()).toBe(0);
  });
});

describe("what it refuses, writing nothing", () => {
  it("more than the customer has", async () => {
    const customer = await makeCustomer("Ada", 50);
    const id = await issuedInvoice(customer.id, 200);
    await expect(pay(id, 60)).rejects.toThrow(/Insufficient store credit: available \$50\.00/);
    expect(await counts()).toEqual(NOTHING);
    expect(await getBalance(customer.id)).toBe(50);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("ISSUED");
    const ledger = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(ledger.openArBalance)).toBe(200);
  });

  it("no credit at all", async () => {
    const customer = await makeCustomer("Ada");
    const id = await issuedInvoice(customer.id, 200);
    await expect(pay(id, 10)).rejects.toThrow(/Insufficient store credit/);
    expect(await counts()).toEqual(NOTHING);
  });

  it("more than the invoice owes, even with the credit to cover it", async () => {
    const customer = await makeCustomer("Ada", 500);
    const id = await issuedInvoice(customer.id, 200);
    await expect(pay(id, 201)).rejects.toThrow(/open balance/);
    expect(await getBalance(customer.id)).toBe(500);
    expect(await counts()).toEqual(NOTHING);
  });

  it("a draft invoice", async () => {
    const customer = await makeCustomer("Ada", 500);
    const { id } = await createDraftInvoice({
      customerId: customer.id,
      lines: [{ description: "x", quantity: 1, unitPrice: 10 }],
    });
    await expect(pay(id, 10)).rejects.toThrow();
    expect(await getBalance(customer.id)).toBe(500);
  });

  it("with Store Credit not mapped to the books, says so and spends nothing", async () => {
    await prisma.systemGLMapping.deleteMany({ where: { label: "Store Credit" } });
    const customer = await makeCustomer("Ada", 500);
    const id = await issuedInvoice(customer.id, 200);
    await expect(pay(id, 100)).rejects.toThrow(/No GL mapping for payment type "Store Credit"/);
    expect(await getBalance(customer.id)).toBe(500);
    expect(await counts()).toEqual(NOTHING);
  });

  it("another customer's credit isn't touched, and can't be", async () => {
    const other = await makeCustomer("Bea", 500);
    const owner = await makeCustomer("Ada", 100);
    const id = await issuedInvoice(owner.id, 200);
    await pay(id, 100);
    expect(await getBalance(other.id)).toBe(500);

    const { paymentId } = await pay(id, 100, "CHECK");
    await expect(
      prisma.$transaction((tx) =>
        spendStoreCreditOnInvoice(tx, {
          customerId: other.id,
          amount: 10,
          paymentId,
          invoiceId: id,
        }),
      ),
    ).rejects.toThrow(StoreCreditError);
    expect(await getBalance(other.id)).toBe(500);
  });

  it("a spend of nothing", async () => {
    const customer = await makeCustomer("Ada", 100);
    const id = await issuedInvoice(customer.id, 200);
    const { paymentId } = await pay(id, 10, "CHECK");
    await expect(
      prisma.$transaction((tx) =>
        spendStoreCreditOnInvoice(tx, {
          customerId: customer.id,
          amount: 0,
          paymentId,
          invoiceId: id,
        }),
      ),
    ).rejects.toThrow(/must be positive/);
  });

  it("two people spending the same credit at once: one gets it", async () => {
    const customer = await makeCustomer("Ada", 100);
    const first = await issuedInvoice(customer.id, 100);
    const second = await issuedInvoice(customer.id, 100);
    const results = await Promise.allSettled([pay(first, 100), pay(second, 100)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await getBalance(customer.id)).toBe(0);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.customerCreditTransaction.count()).toBe(1);
  });
});

describe("what the invoice screen is told", () => {
  it("how much credit the customer has", async () => {
    const customer = await makeCustomer("Ada", 75.5);
    const id = await issuedInvoice(customer.id, 200);
    expect((await getInvoiceDetail(id)).customerCredit).toBe(75.5);
    await pay(id, 25.5);
    expect((await getInvoiceDetail(id)).customerCredit).toBe(50);
  });

  it("offers store credit as a method, under the label the books map", () => {
    expect(INVOICE_PAYMENT_METHODS).toContain("STORE_CREDIT");
    expect(INVOICE_PAYMENT_LABELS.STORE_CREDIT).toBe("Store Credit");
  });
});

describe("through the router", () => {
  async function adminCaller() {
    await prisma.appSettings.create({
      data: { organizationId: 1, appName: "Test Co", features: { billing: true } },
    });
    invalidateAppSettingsCache();
    const user = await prisma.user.create({
      data: { id: "admin-user", email: "admin@test.holt" },
    });
    await prisma.staffMember.create({
      data: {
        displayName: "Admin",
        email: user.email ?? undefined,
        role: "ADMIN" as never,
        isActive: true,
        userId: user.id,
      },
    });
    return createCallerFactory(appRouter)({
      userId: user.id,
      userEmail: user.email,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    });
  }

  it("takes the method, and answers a shortfall as a reason, not a failure", async () => {
    const caller = await adminCaller();
    const customer = await makeCustomer("Ada", 50);
    const id = await issuedInvoice(customer.id, 200);
    await expect(
      caller.billing.recordPayment({ id, amount: 60, method: "STORE_CREDIT" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/Insufficient store credit/),
    });
    const ok = await caller.billing.recordPayment({ id, amount: 50, method: "STORE_CREDIT" });
    expect(ok.openBalance).toBe(150);
    expect((await caller.billing.detail({ id })).customerCredit).toBe(0);
  });
});
