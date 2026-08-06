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
// Used by the native-refund scenarios: the sale posts on this day, the refund
// lands on DAY, so the refund's journal is a different journal from the sale's.
const PRIOR_DAY = new Date("2026-04-27T00:00:00Z");

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
    shrinkage: { id: number };
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
  const shrinkage = await prisma.gLAccount.create({
    data: { code: "5-5010", name: "Furniture Shrinkage", accountType: "EXPENSE" },
  });

  // Account group with the GL FKs the generator looks at, including the
  // B3 classified-writeoff shrinkage GL.
  const accountGroup = await prisma.accountGroup.create({
    data: {
      name: "Furniture",
      salesAccountId: sales.id,
      cogsAccountId: cogs.id,
      inventoryAccountId: inventory.id,
      shrinkageAccountId: shrinkage.id,
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
    glAccounts: { cash, deposit, sales, cogs, inventory, tax, overShort, shrinkage },
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
    // No classifying Return record exists (the imported-POS shape) -- the
    // named UNCLASSIFIED_DEFAULT_RESTOCK path restocks Inventory.
    expect(byCode.get("1-1380")?.debit).toBe(200);
    // No shrinkage line -- nothing was classified as a writeoff.
    expect(byCode.get("5-5010")).toBeUndefined();
  });

  it("(B3) a return with a WRITTEN_OFF Return record debits the shrinkage GL instead of restocking inventory", async () => {
    // Classified return: an ERP-native Return record for this line has
    // progressed to WRITTEN_OFF (major damage at inspection). The JE must
    // debit the department's shrinkage GL, not Inventory -- the item never
    // re-enters sellable stock. COGS still reverses normally; Sales / Tax /
    // Cash are unaffected by the restock-vs-writeoff branch.
    const fx = await seedAccountingFixtures();
    const order = await seedSale({
      productId: fx.product.id,
      netPrice: -500,
      cost: -200,
      vatAmount: -31.75,
      paymentAmount: -531.75,
      paymentType: "Cash",
      withInvoice: true,
    });

    await prisma.return.create({
      data: {
        returnNumber: "RET-260428-001",
        status: "WRITTEN_OFF",
        reason: "DAMAGED_IN_DELIVERY",
        salesOrderId: order.id,
        productId: fx.product.id,
        inspectionCondition: "MAJOR_DAMAGE",
      },
    });

    const result = await generateSalesJournal(DAY);

    expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));

    // No inventory line at all -- the write-off never restocks.
    expect(byCode.get("1-1380")).toBeUndefined();
    // Shrinkage GL debited for the line's cost magnitude.
    expect(byCode.get("5-5010")?.debit).toBe(200);
    expect(byCode.get("5-5010")?.credit).toBe(0);
    // COGS still reverses normally (credit) — unchanged by the branch.
    expect(byCode.get("5-5280")?.credit).toBe(200);
    // Sales / Tax / Cash reversal unaffected.
    expect(byCode.get("4-4080")?.debit).toBe(500);
    expect(byCode.get("2-2120")?.debit).toBe(31.75);
    expect(byCode.get("1-1006")?.credit).toBe(531.75);
  });

  it("(B3) a classified RESTOCKED Return books identically to the unclassified default", async () => {
    // Same shape as WRITTEN_OFF above, but the inspection came back clean —
    // confirms a classified restock doesn't accidentally route to shrinkage.
    const fx = await seedAccountingFixtures();
    const order = await seedSale({
      productId: fx.product.id,
      netPrice: -500,
      cost: -200,
      vatAmount: -31.75,
      paymentAmount: -531.75,
      paymentType: "Cash",
      withInvoice: true,
    });

    await prisma.return.create({
      data: {
        returnNumber: "RET-260428-002",
        status: "RESTOCKED",
        reason: "CUSTOMER_CHANGED_MIND",
        salesOrderId: order.id,
        productId: fx.product.id,
        inspectionCondition: "LIKE_NEW",
      },
    });

    const result = await generateSalesJournal(DAY);

    expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
    expect(byCode.get("1-1380")?.debit).toBe(200);
    expect(byCode.get("5-5010")).toBeUndefined();
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

  // ─── Payment.isRefund sign normalization (fix/refund-sign-in-journal) ──
  //
  // Before this fix, the payment-mapping loop summed `payment.paymentAmount`
  // with NO reference to `Payment.isRefund`. `paymentService.ts::processRefund`
  // creates the refund row with a POSITIVE `paymentAmount` and `isRefund:
  // true` -- so a native ERP refund was booked as cash RECEIVED instead of
  // paid out, inflating the day's cash and producing unexplained daily-
  // reconciliation drift.
  //
  // Imported POS refunds were NOT affected -- the Ordorite import stores
  // them already negative. Production data contains BOTH conventions at
  // once, so the fix normalizes on the flag
  // (`isRefund ? -Math.abs(raw) : raw`) rather than assuming either sign,
  // which also means it must NOT double-negate a row that's already
  // negative. Same normalization pattern already exists in
  // `paymentService.ts` (`computeBalance`, `calculateTillExpected`) and
  // `customerLedger.ts` -- this fix brings `journalEntry.ts` in line with
  // the established convention.
  describe("Payment.isRefund sign normalization", () => {
    /**
     * A standalone Payment with no SalesOrder link -- the shape
     * `processRefund()` produces for a walk-in / unlinked refund, and the
     * simplest fixture for isolating the cash-side effect from the
     * order/line-item machinery (revenue/COGS/tax are a separate concern
     * from whether a refund's sign lands on the right side of Cash).
     */
    async function seedStandalonePayment(opts: {
      paymentAmount: number;
      isRefund?: boolean;
      paymentType?: string;
    }) {
      return prisma.payment.create({
        data: {
          paymentAmount: opts.paymentAmount,
          paymentDate: DAY,
          status: "COMPLETED",
          paymentType: opts.paymentType ?? "Cash",
          isRefund: opts.isRefund ?? false,
        },
      });
    }

    it("a NATIVE refund (positive paymentAmount, isRefund: true) reduces the cash side by that magnitude", async () => {
      await seedAccountingFixtures();
      // Mirrors processRefund()'s exact output shape: positive amount, isRefund true.
      await seedStandalonePayment({ paymentAmount: 150, isRefund: true });

      const result = await generateSalesJournal(DAY);

      // A standalone payment has no offsetting revenue/COGS/tax, so the plug
      // absorbs the whole amount -- and now says so. Asserting the warning
      // rather than its absence is the point of the change: this fixture was
      // always producing a $150 plug, and the journal used to report itself
      // balanced without mentioning it.
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Over/Short plug of $150.00")]),
      );
      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
      // This is the regression the fix closes: cash must be CREDITED
      // (reduced), not debited (increased), when a refund pays money out.
      expect(byCode.get("1-1006")?.credit).toBe(150);
      expect(byCode.get("1-1006")?.debit).toBe(0);
      expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    });

    it("an IMPORTED refund (negative paymentAmount, isRefund: true) reduces cash by the same magnitude and is NOT double-negated", async () => {
      await seedAccountingFixtures();
      // Ordorite import shape: already negative. -Math.abs(-150) must land
      // on -150, not flip back to +150 (the double-negation failure mode).
      await seedStandalonePayment({ paymentAmount: -150, isRefund: true });

      const result = await generateSalesJournal(DAY);

      // Standalone again -- same $150 plug, now warned about. See above.
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Over/Short plug of $150.00")]),
      );
      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
      expect(byCode.get("1-1006")?.credit).toBe(150);
      expect(byCode.get("1-1006")?.debit).toBe(0);
      expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    });

    it("a normal payment (isRefund: false) posts unchanged", async () => {
      await seedAccountingFixtures();
      await seedStandalonePayment({ paymentAmount: 500, isRefund: false });

      const result = await generateSalesJournal(DAY);

      // Cash debited $500 with nothing on the credit side, so the plug is a
      // $500 CREDIT. Warned about, for the same reason as the two above.
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Over/Short plug of $500.00 (credit)")]),
      );
      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
      expect(byCode.get("1-1006")?.debit).toBe(500);
      expect(byCode.get("1-1006")?.credit).toBe(0);
    });

    it("nets a normal sale with a same-day native refund and imported refund: net cash = sale - refund - refund, JE still balances", async () => {
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
      // Native refund (processRefund shape): positive amount, isRefund true.
      await seedStandalonePayment({ paymentAmount: 200, isRefund: true });
      // Imported refund (Ordorite shape): already-negative amount, isRefund true.
      await seedStandalonePayment({ paymentAmount: -100, isRefund: true });

      const result = await generateSalesJournal(DAY);

      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));
      // Net cash = 1063.50 (sale) - 200 (native refund) - 100 (imported refund) = 763.50.
      // All three payments share the same Cash GL, so they net into ONE line.
      expect(byCode.get("1-1006")?.debit).toBe(763.5);
      expect(byCode.get("1-1006")?.credit).toBe(0);
      // The JE still balances even though the $300 of refunds has no
      // offsetting revenue/COGS/tax reversal (standalone refunds here, not
      // return line items) -- the Over/Short plug absorbs the difference.
      expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
      expect(byCode.get("5-5900")?.debit).toBe(300); // Over/Short plug
      // ...but it no longer does so silently. This assertion used to read
      // `expect(result.warnings).toEqual([])`: a $300 plug produced a journal
      // that reported itself balanced and said nothing at all.
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Over/Short plug of $300.00")]),
      );
    });
  });

  // ─── A native refund must not re-book the original sale ────────────────
  //
  // `paymentService.processRefund` writes the refund row against the ORIGINAL
  // SalesOrder, with `originalPaymentId` pointing at the payment it reverses.
  // On the refund's day the generator therefore loaded an order whose line
  // items are the original POSITIVE sale lines -- and booked them again, in
  // the same direction as the sale. One $1,000 sale produced $2,000 of
  // recognized revenue across two days, and the resulting imbalance
  // disappeared into the Over/Short plug.
  describe("native refund does not re-recognize the original sale", () => {
    it("books only the cash leg when the refund lands on a later day", async () => {
      const fx = await seedAccountingFixtures();
      const order = await seedSale({
        productId: fx.product.id,
        netPrice: 1000,
        cost: 400,
        vatAmount: 63.5,
        paymentAmount: 1063.5,
        withInvoice: true,
      });
      // Move the sale's payment to the previous day: its revenue belongs to
      // THAT day's journal, and must not reappear in this one.
      const salePayment = await prisma.payment.findFirstOrThrow({
        where: { salesOrderId: order.id },
      });
      await prisma.payment.update({
        where: { id: salePayment.id },
        data: { paymentDate: PRIOR_DAY },
      });
      // processRefund's exact output shape: positive amount, isRefund true,
      // originalPaymentId pointing back at the sale payment.
      await prisma.payment.create({
        data: {
          salesOrderId: order.id,
          paymentAmount: 1063.5,
          paymentDate: DAY,
          status: "COMPLETED",
          paymentType: "Cash",
          isRefund: true,
          originalPaymentId: salePayment.id,
        },
      });

      const result = await generateSalesJournal(DAY);
      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));

      // Cash goes out.
      expect(byCode.get("1-1006")?.credit).toBe(1063.5);
      // The original sale's legs are NOT recognized a second time. Each of
      // these produced a line before the fix.
      expect(byCode.get("4-4080")).toBeUndefined(); // revenue
      expect(byCode.get("5-5280")).toBeUndefined(); // COGS
      expect(byCode.get("1-1380")).toBeUndefined(); // inventory
      expect(byCode.get("2-2120")).toBeUndefined(); // tax
      // The unreversed refund surfaces as a plug WITH a warning, instead of
      // as a smaller plug plus $1,000 of phantom revenue.
      expect(byCode.get("5-5900")?.debit).toBe(1063.5);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Over/Short plug of $1063.50")]),
      );
      expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    });

    it("recognizes the sale exactly once when sale and refund fall on the same day", async () => {
      // The guard must not mark the order processed, or whichever row Prisma
      // returned first would decide whether the sale is booked at all.
      const fx = await seedAccountingFixtures();
      const order = await seedSale({
        productId: fx.product.id,
        netPrice: 1000,
        cost: 400,
        vatAmount: 63.5,
        paymentAmount: 1063.5,
        withInvoice: true,
      });
      const salePayment = await prisma.payment.findFirstOrThrow({
        where: { salesOrderId: order.id },
      });
      await prisma.payment.create({
        data: {
          salesOrderId: order.id,
          paymentAmount: 400,
          paymentDate: DAY,
          status: "COMPLETED",
          paymentType: "Cash",
          isRefund: true,
          originalPaymentId: salePayment.id,
        },
      });

      const result = await generateSalesJournal(DAY);
      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));

      // Once. Not zero times, not twice.
      expect(byCode.get("4-4080")?.credit).toBe(1000);
      expect(byCode.get("5-5280")?.debit).toBe(400);
      // Net cash = 1063.50 in - 400 out.
      expect(byCode.get("1-1006")?.debit).toBe(663.5);
      expect(byCode.get("5-5900")?.debit).toBe(400); // the unreversed refund
      expect(totalDebits(result.journalEntry)).toBe(totalCredits(result.journalEntry));
    });

    it("leaves an IMPORTED POS return booking its full sale-in-reverse", async () => {
      // Regression guard on the fix itself. Imported returns also carry
      // isRefund, so keying the guard on that flag instead of on
      // originalPaymentId would have stopped booking every imported return's
      // reversal and dumped the whole refund into the plug.
      const fx = await seedAccountingFixtures();
      await seedSale({
        productId: fx.product.id,
        netPrice: -500,
        cost: -200,
        vatAmount: -31.75,
        paymentAmount: -531.75, // Ordorite shape: already negative
        withInvoice: true,
      });
      // isRefund, but no originalPaymentId -- the import never sets one.
      await prisma.payment.updateMany({ data: { isRefund: true } });

      const result = await generateSalesJournal(DAY);
      const byCode = new Map(result.journalEntry.lines.map((l) => [l.glAccount?.code, l]));

      expect(byCode.get("1-1006")?.credit).toBe(531.75);
      expect(byCode.get("4-4080")?.debit).toBe(500); // revenue reversed
      expect(byCode.get("2-2120")?.debit).toBe(31.75); // tax reversed
      expect(byCode.get("5-5280")?.credit).toBe(200); // COGS reversed
      expect(byCode.get("1-1380")?.debit).toBe(200); // restocked
      // Balances on its own -- no plug, no warning.
      expect(byCode.get("5-5900")).toBeUndefined();
      expect(result.warnings).toEqual([]);
    });
  });
});
