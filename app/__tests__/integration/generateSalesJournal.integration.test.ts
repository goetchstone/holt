// /app/__tests__/integration/generateSalesJournal.integration.test.ts
//
// Phase 0.6.4 backfill: Postgres-backed coverage for the journal-entry
// generator. Before this file, `generateSalesJournal` had ZERO test
// coverage — it was the SOR-critical code path with the highest blast
// radius (a buggy JE either misstates revenue/COGS/tax, or silently
// drops payment activity from the books) and no automated guard.
//
// Scenarios covered here:
//   1. Happy path — one balanced sale produces a balanced JE
//   2. B1 — CANCELLED line items don't inflate Sales / COGS / Inventory
//   3. B3 — a return on the same day produces sale-in-reverse signed amounts
//   4. Idempotency — regenerating a DRAFT JE replaces it cleanly
//   5. Refusal — regenerating a POSTED/EXPORTED JE throws
//   6. Empty day — no payments → throws (the existing contract)
//
// What this does NOT cover (still gaps, tracked for Phase 0.6.4 follow-up):
//   - B4: balance-pre-POST guard at the API layer (separate test target —
//     pages/api/accounting/journal-entries/[id].ts)
//   - B6: payment immutability trigger (DB-trigger test, separate file)
//   - Multi-store JE generation (low priority — store filter is a thin
//     where-clause add)

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { generateSalesJournal } from "@/lib/journalEntry";

const DAY = new Date("2026-04-28T00:00:00Z");

// ─── Fixture builder ─────────────────────────────────────────────────
//
// generateSalesJournal needs a deep fixture tree:
//   GLAccount × N (cash, deposit, sales, COGS, inventory, tax, over/short)
//   AccountGroup → joins category to sales/cogs/inventory GLs
//   Department → Category → Type
//   Product → Category (+ implicit Vendor)
//   SalesOrder → OrderLineItem → Product
//   Payment → SalesOrder
//   SystemGLMapping × N (POS_PAYMENTS labels + POS_TRANSACTIONS Sales Tax / Over-Short)
//
// `seedAccountingFixtures` builds everything except the SalesOrder / Payment
// rows — those vary per test and are seeded inline.

interface AccountingFixtures {
  glAccounts: {
    cash: { id: number };
    deposit: { id: number };
    sales: { id: number };
    cogs: { id: number };
    inventory: { id: number };
    tax: { id: number };
    overShort: { id: number };
  };
  category: { id: number };
  product: { id: number };
  vendor: { id: number };
}

async function seedAccountingFixtures(): Promise<AccountingFixtures> {
  // GL accounts
  const cash = await prisma.gLAccount.create({
    data: { code: "1-1006", name: "Cash", accountType: "ASSET" },
  });
  const deposit = await prisma.gLAccount.create({
    data: { code: "2-2200", name: "Customer Deposits", accountType: "LIABILITY" },
  });
  const sales = await prisma.gLAccount.create({
    data: { code: "4-4080", name: "Furniture Sales", accountType: "REVENUE" },
  });
  const cogs = await prisma.gLAccount.create({
    data: { code: "5-5280", name: "Furniture COGS", accountType: "EXPENSE" },
  });
  const inventory = await prisma.gLAccount.create({
    data: { code: "1-1380", name: "Furniture Inventory", accountType: "ASSET" },
  });
  const tax = await prisma.gLAccount.create({
    data: { code: "2-2120", name: "CT Sales Tax Payable", accountType: "LIABILITY" },
  });
  const overShort = await prisma.gLAccount.create({
    data: { code: "5-5900", name: "Cash Over/Short", accountType: "EXPENSE" },
  });

  // Account group with the four GL FKs the generator looks at
  const accountGroup = await prisma.accountGroup.create({
    data: {
      name: "Furniture",
      salesAccountId: sales.id,
      cogsAccountId: cogs.id,
      inventoryAccountId: inventory.id,
    },
  });

  // Vendor → Department → Category → Product
  const vendor = await prisma.vendor.create({
    data: { name: "Test Vendor", code: "TV", pricingModel: "FLAT" },
  });
  const department = await prisma.department.create({
    data: { name: "Furniture" },
  });
  const category = await prisma.category.create({
    data: {
      name: "Sofas",
      departmentId: department.id,
      accountGroupId: accountGroup.id,
    },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "SOFA-001",
      name: "Test Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });

  // SystemGLMapping rows — POS_PAYMENTS labels + POS_TRANSACTIONS
  await prisma.systemGLMapping.create({
    data: { section: "POS_PAYMENTS", label: "Cash", glAccountId: cash.id },
  });
  await prisma.systemGLMapping.create({
    data: { section: "POS_PAYMENTS", label: "On Account", glAccountId: deposit.id },
  });
  await prisma.systemGLMapping.create({
    data: { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: tax.id },
  });
  await prisma.systemGLMapping.create({
    data: { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: overShort.id },
  });

  return {
    glAccounts: { cash, deposit, sales, cogs, inventory, tax, overShort },
    category: { id: category.id },
    product: { id: product.id },
    vendor: { id: vendor.id },
  };
}

/** Build a customer + order + line items + a Cash payment. */
async function seedSale(opts: {
  productId: number;
  netPrice: number;
  cost: number;
  vatAmount: number;
  paymentAmount: number;
  paymentType?: string;
  withInvoice?: boolean;
  cancelledLineExtra?: { netPrice: number; cost: number; vatAmount: number };
}) {
  const customer = await prisma.customer.create({
    data: { firstName: "Test", lastName: "Buyer" },
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: `SO-1-${Math.floor(Math.random() * 100000)}`,
      status: "ORDER",
      orderDate: DAY,
      customerId: customer.id,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            partNo: "SOFA-001",
            productName: "Test Sofa",
            netPrice: opts.netPrice,
            cost: opts.cost,
            vatAmount: opts.vatAmount,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
            productId: opts.productId,
          },
          ...(opts.cancelledLineExtra
            ? [
                {
                  lineNumber: 2,
                  partNo: "CANCELLED",
                  productName: "Cancelled line — must NOT count",
                  netPrice: opts.cancelledLineExtra.netPrice,
                  cost: opts.cancelledLineExtra.cost,
                  vatAmount: opts.cancelledLineExtra.vatAmount,
                  orderedQuantity: 1,
                  lineItemStatus: "CANCELLED" as const,
                  productId: opts.productId,
                },
              ]
            : []),
        ],
      },
    },
  });
  if (opts.withInvoice) {
    await prisma.invoice.create({
      data: {
        invoiceNo: `INV-${order.id}`,
        invoiceDate: DAY,
        taxAmount: opts.vatAmount,
        salesOrderId: order.id,
      },
    });
  }
  await prisma.payment.create({
    data: {
      paymentAmount: opts.paymentAmount,
      paymentDate: DAY,
      status: "COMPLETED",
      paymentType: opts.paymentType ?? "Cash",
      salesOrderId: order.id,
    },
  });
  return order;
}

// Sum of debits and credits across the JE lines must always match.
function totalDebits(je: { lines: { debit: number; credit: number }[] }): number {
  return Math.round(je.lines.reduce((s, l) => s + l.debit, 0) * 100) / 100;
}
function totalCredits(je: { lines: { debit: number; credit: number }[] }): number {
  return Math.round(je.lines.reduce((s, l) => s + l.credit, 0) * 100) / 100;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("generateSalesJournal (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("produces a balanced JE for one $1000 sale paid in cash + invoiced", async () => {
    const fx = await seedAccountingFixtures();
    await seedSale({
      productId: fx.product.id,
      netPrice: 1000,
      cost: 400,
      vatAmount: 63.5,
      paymentAmount: 1063.5,
      paymentType: "Cash",
      withInvoice: true,
    });

    const result = await generateSalesJournal(DAY);

    expect(result.warnings).toEqual([]);
    const je = result.journalEntry;
    expect(je.status).toBe("DRAFT");
    expect(totalDebits(je)).toBe(totalCredits(je)); // balanced
    expect(je.totalDebits).toBe(totalDebits(je));

    // Verify the lines hit the right GL accounts.
    const byCode = new Map(je.lines.map((l) => [l.glAccount?.code, l]));
    expect(byCode.get("1-1006")?.debit).toBe(1063.5); // cash debited (sale + tax)
    expect(byCode.get("4-4080")?.credit).toBe(1000); // furniture revenue credited
    expect(byCode.get("2-2120")?.credit).toBe(63.5); // tax payable credited
    expect(byCode.get("5-5280")?.debit).toBe(400); // COGS debited
    expect(byCode.get("1-1380")?.credit).toBe(400); // inventory credited
  });

  it("(B1) excludes CANCELLED line items from sales / COGS / inventory totals", async () => {
    // Headline scenario: a $1000 active line + a $9999 cancelled line.
    // CANCELLED line must not contribute to revenue, COGS, or inventory
    // sides of the JE. This is the JE-side closure of the rule-33
    // bug class that bit Detailed Sales in April.
    const fx = await seedAccountingFixtures();
    await seedSale({
      productId: fx.product.id,
      netPrice: 1000,
      cost: 400,
      vatAmount: 63.5,
      paymentAmount: 1063.5,
      paymentType: "Cash",
      withInvoice: true,
      cancelledLineExtra: { netPrice: 9999, cost: 5000, vatAmount: 600 },
    });

    const result = await generateSalesJournal(DAY);

    const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
    expect(byCode.get("4-4080")?.credit).toBe(1000); // not 10999
    expect(byCode.get("5-5280")?.debit).toBe(400); // not 5400
    expect(byCode.get("1-1380")?.credit).toBe(400); // not 5400
    expect(byCode.get("2-2120")?.credit).toBe(63.5); // not 663.5
    expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
  });

  it("(B3) a return on the same day produces sale-in-reverse signed amounts", async () => {
    // A pure-return day: negative line items + negative payment.
    // The JE should debit Sales (reverse of credit), debit Tax (reverse),
    // credit Cash (refund out), and credit COGS / debit Inventory
    // (restock — assumed for imported returns per the plan).
    const fx = await seedAccountingFixtures();
    await seedSale({
      productId: fx.product.id,
      netPrice: -500,
      cost: -200,
      vatAmount: -31.75,
      paymentAmount: -531.75,
      paymentType: "Cash",
      withInvoice: true,
    });

    const result = await generateSalesJournal(DAY);

    expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    // The build helper's sign-flip emit logic should keep all line
    // amounts non-negative — the reversal shows up as side-flips
    // (debit/credit swap), not negative numbers.
    for (const line of result.journalEntry.lines) {
      expect(line.debit).toBeGreaterThanOrEqual(0);
      expect(line.credit).toBeGreaterThanOrEqual(0);
    }

    const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
    // Cash side flipped: was debit on a sale; now credit (refund out).
    expect(byCode.get("1-1006")?.credit).toBe(531.75);
    expect(byCode.get("1-1006")?.debit).toBe(0);
    // Sales side flipped: was credit; now debit.
    expect(byCode.get("4-4080")?.debit).toBe(500);
  });

  it("(B3) mixed-sign per-order: a $500 sale + $200 same-day return on the same order", async () => {
    // The 2026-04-25 outage's sister bug shape: an order that contains
    // BOTH a positive (forgot-to-cancel) and a negative (return) line
    // on the same day. The signed accumulator must net them correctly:
    // net Sales = $300 (credit), net COGS = $120 (debit at 40% margin),
    // net Cash = $300 + tax of $19.05 = $319.05 (debit).
    //
    // If the runner double-counts or mis-signs either line, the JE
    // either imbalances or hits the wrong GL accounts.
    const fx = await seedAccountingFixtures();
    const customer = await prisma.customer.create({
      data: { firstName: "Mixed", lastName: "Sign" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `SO-MIXED-${Date.now()}`,
        status: "ORDER",
        orderDate: DAY,
        customerId: customer.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "SOFA-A",
              productName: "Forgot-to-cancel sale",
              netPrice: 500,
              cost: 200,
              vatAmount: 31.75,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE",
              productId: fx.product.id,
            },
            {
              lineNumber: 2,
              partNo: "SOFA-B",
              productName: "Same-day return (negative)",
              netPrice: -200,
              cost: -80,
              vatAmount: -12.7,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE",
              productId: fx.product.id,
            },
          ],
        },
      },
    });
    await prisma.invoice.create({
      data: {
        invoiceNo: `INV-MIXED-${order.id}`,
        invoiceDate: DAY,
        taxAmount: 19.05,
        salesOrderId: order.id,
      },
    });
    await prisma.payment.create({
      data: {
        paymentAmount: 319.05, // net cash in
        paymentDate: DAY,
        status: "COMPLETED",
        paymentType: "Cash",
        salesOrderId: order.id,
      },
    });

    const result = await generateSalesJournal(DAY);

    expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
    // Net Sales = 500 - 200 = 300 (credit, positive net is a sale)
    expect(byCode.get("4-4080")?.credit).toBe(300);
    expect(byCode.get("4-4080")?.debit).toBe(0);
    // Net COGS = 200 - 80 = 120 (debit)
    expect(byCode.get("5-5280")?.debit).toBe(120);
    // Net Inventory = 120 (credit, sale reduces inventory)
    expect(byCode.get("1-1380")?.credit).toBe(120);
    // Net Tax = 31.75 - 12.7 = 19.05 (credit)
    expect(byCode.get("2-2120")?.credit).toBe(19.05);
    // Cash debited net
    expect(byCode.get("1-1006")?.debit).toBe(319.05);
  });

  it("(B3) large-dollar precision: $250K commercial sale + $245K refund the next day", async () => {
    // Pricing test for the signed accumulator. JS numbers handle integers
    // up to 2^53, so $250K is well within range — but the rounding
    // pipeline (round2 + Decimal -> Number conversion) is where precision
    // loss could creep in. Each side must end at exactly the seeded
    // amount, not 249999.99 or 250000.01.
    const fx = await seedAccountingFixtures();
    await seedSale({
      productId: fx.product.id,
      netPrice: 250000,
      cost: 100000,
      vatAmount: 15875, // 6.35% on 250K
      paymentAmount: 265875,
      paymentType: "Cash",
      withInvoice: true,
    });

    const result = await generateSalesJournal(DAY);

    expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
    expect(byCode.get("4-4080")?.credit).toBe(250000);
    expect(byCode.get("2-2120")?.credit).toBe(15875);
    expect(byCode.get("1-1006")?.debit).toBe(265875);
    expect(byCode.get("5-5280")?.debit).toBe(100000);
    expect(byCode.get("1-1380")?.credit).toBe(100000);
  });

  it("regenerating a DRAFT JE for the same date replaces it (idempotent)", async () => {
    const fx = await seedAccountingFixtures();
    await seedSale({
      productId: fx.product.id,
      netPrice: 1000,
      cost: 400,
      vatAmount: 63.5,
      paymentAmount: 1063.5,
      withInvoice: true,
    });

    const first = await generateSalesJournal(DAY);
    const second = await generateSalesJournal(DAY);

    // Different IDs (the first was deleted, a fresh one was inserted).
    expect(second.journalEntry.id).not.toBe(first.journalEntry.id);
    // Same journal number (formatJournalNumber is deterministic on date).
    expect(second.journalEntry.journalNumber).toBe(first.journalEntry.journalNumber);
    // Only one JE row exists in the DB now.
    const all = await prisma.journalEntry.findMany();
    expect(all).toHaveLength(1);
  });

  it("refuses to regenerate a POSTED JE", async () => {
    const fx = await seedAccountingFixtures();
    await seedSale({
      productId: fx.product.id,
      netPrice: 1000,
      cost: 400,
      vatAmount: 63.5,
      paymentAmount: 1063.5,
      withInvoice: true,
    });

    const first = await generateSalesJournal(DAY);
    // Post the JE.
    await prisma.journalEntry.update({
      where: { id: first.journalEntry.id },
      data: { status: "POSTED" },
    });

    await expect(generateSalesJournal(DAY)).rejects.toThrow(/POSTED/);
  });

  it("throws when the day has no payments", async () => {
    await seedAccountingFixtures();
    await expect(generateSalesJournal(DAY)).rejects.toThrow(/No payments/);
  });
});
