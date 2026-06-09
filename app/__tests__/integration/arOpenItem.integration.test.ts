// /app/__tests__/integration/arOpenItem.integration.test.ts
//
// Real-DB proof that the open-item AR layer (lib/ar.ts) computes a customer's
// position + reconciliation correctly from actual Postgres rows -- invoices,
// payments, and PaymentApplication allocations. This is money code, so the proof
// is a real round-trip, not mocked Prisma: it's the SQL mapping + the engine
// together. The pure math itself is covered exhaustively in arEngine.test.ts.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { getCustomerArPosition, reconcileCustomer } from "@/lib/ar";

async function makeCustomer(name: string) {
  return prisma.customer.create({ data: { firstName: name } });
}
async function makeInvoice(customerId: number, no: string, total: number, status = "ISSUED") {
  return prisma.invoice.create({
    data: {
      invoiceNo: no,
      invoiceDate: new Date(),
      taxAmount: 0,
      total,
      status: status as never,
      customerId,
      dueDate: new Date(),
    },
  });
}
async function makePayment(customerId: number, amount: number) {
  return prisma.payment.create({
    data: { paymentDate: new Date(), paymentType: "CASH", paymentAmount: amount, customerId },
  });
}
async function apply(paymentId: number, invoiceId: number, amountApplied: number) {
  return prisma.paymentApplication.create({
    data: { organizationId: 1, paymentId, invoiceId, amountApplied },
  });
}

describe("open-item AR (lib/ar.ts) against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
    await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("computes position from applied payments + on-account credit", async () => {
    // $1000 invoice; pay $600 (applied) then $500 of which $400 is applied,
    // $100 left on-account.
    const cust = await makeCustomer("Dana");
    const inv = await makeInvoice(cust.id, "INV-1", 1000);
    const p1 = await makePayment(cust.id, 600);
    const p2 = await makePayment(cust.id, 500);
    await apply(p1.id, inv.id, 600);
    await apply(p2.id, inv.id, 400);

    const { position } = await getCustomerArPosition(cust.id);
    expect(position.ar.toFixed(2)).toBe("0.00"); // 1000 - 600 - 400
    expect(position.onAccountCredit.toFixed(2)).toBe("100.00"); // 500 - 400
    expect(position.netOwed.toFixed(2)).toBe("-100.00"); // in credit

    const recon = await reconcileCustomer(cust.id);
    expect(recon.ok).toBe(true);
  });

  it("leaves an open balance on a partial payment", async () => {
    const cust = await makeCustomer("Lee");
    const inv = await makeInvoice(cust.id, "INV-P", 1000);
    const p = await makePayment(cust.id, 600);
    await apply(p.id, inv.id, 600);

    const { position } = await getCustomerArPosition(cust.id);
    expect(position.ar.toFixed(2)).toBe("400.00");
    expect(position.netOwed.toFixed(2)).toBe("400.00");
    expect((await reconcileCustomer(cust.id)).ok).toBe(true);
  });

  it("reconcile catches an over-applied invoice in the DB", async () => {
    const cust = await makeCustomer("Sam");
    const inv = await makeInvoice(cust.id, "INV-2", 100);
    const p = await makePayment(cust.id, 200);
    await apply(p.id, inv.id, 120); // 120 > 100 -> corruption the tie-out must catch

    const recon = await reconcileCustomer(cust.id);
    expect(recon.ok).toBe(false);
    expect(recon.discrepancies.map((d) => d.kind)).toContain("INVOICE_OVERAPPLIED");
    expect(recon.discrepancies[0].ref).toBe(`invoice:${inv.id}`);
  });

  it("excludes DRAFT invoices from AR", async () => {
    const cust = await makeCustomer("Jo");
    await makeInvoice(cust.id, "INV-3", 999, "DRAFT");
    const { position } = await getCustomerArPosition(cust.id);
    expect(position.ar.toFixed(2)).toBe("0.00"); // not recognized until ISSUED
  });
});
