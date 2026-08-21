// /app/__tests__/integration/dailyReconciliation.integration.test.ts
//
// Phase 0.6.3 conversion: dailyReconciliation orchestration. Replaces
// the C+ mocked-Prisma block in __tests__/dailyReconciliation.test.ts.
// The compareReconciliation pure-helper tests in that file stay where
// they are (A grade).
//
// Why this conversion: the orchestration test was Control C1 of the
// SOR plan. We bet the books on it. A mocked test that returns canned
// data via jest.fn() doesn't tell us whether the real query against
// the schema picks up the right rows — date-range edge cases, FK
// joins, decimal precision, status filters. This file does.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { computeDailyReconciliation } from "@/lib/dailyReconciliation";

const DAY = new Date("2026-04-28T00:00:00Z");

interface SeedJournalLineSpec {
  code: string;
  debit?: number;
  credit?: number;
}

/** Seed a customer (most fixtures need one). */
async function seedCustomer() {
  return prisma.customer.create({
    data: { firstName: "Test", lastName: "Customer" },
  });
}

/** Seed a SalesOrder on DAY with the given line items + status. */
async function seedOrder(opts: {
  orderno: string;
  status?: "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED";
  lines: { netPrice: number; vatAmount?: number; cost: number; lineItemStatus?: string }[];
  customerId: number;
}) {
  return prisma.salesOrder.create({
    data: {
      orderno: opts.orderno,
      status: opts.status ?? "ORDER",
      orderDate: DAY,
      customerId: opts.customerId,
      lineItems: {
        create: opts.lines.map((l, i) => ({
          lineNumber: i + 1,
          netPrice: l.netPrice,
          vatAmount: l.vatAmount ?? 0,
          cost: l.cost,
          orderedQuantity: 1,
          lineItemStatus: (l.lineItemStatus ?? "ACTIVE") as "ACTIVE" | "CANCELLED",
        })),
      },
    },
  });
}

/** Seed a Payment on DAY. */
async function seedPayment(amount: number) {
  return prisma.payment.create({
    data: {
      paymentAmount: amount,
      paymentDate: DAY,
      status: "COMPLETED",
      paymentType: "CASH",
    },
  });
}

/**
 * Create-or-find a GLAccount by code. Each test starts with a fresh
 * DB (resetTestDb truncates), so within a test we create. Across
 * tests within a single test body we may need to create the same
 * code more than once — guarded by a findFirst.
 */
async function ensureGlAccount(code: string, name: string, accountType = "ASSET") {
  const existing = await prisma.gLAccount.findFirst({ where: { code } });
  if (existing) return existing;
  return prisma.gLAccount.create({ data: { code, name, accountType } });
}

/**
 * The chart of accounts under test, expressed as ROLES rather than codes.
 *
 * This is the whole point of the change these tests cover. The reconciliation
 * used to identify buckets with `code.startsWith("4-")`, `code === "2-2120"`,
 * `code.startsWith("5-52")` and `code === "1-1006"` — four facts about one
 * business's numbering, hardcoded in product source (CLAUDE.md rule 61). It
 * now reads AccountGroup / TaxDistrict / SystemGLMapping instead, so the codes
 * below are arbitrary. The "alien chart" suite at the bottom of this file
 * proves that by running the identical scenario through a scheme with no `4-`
 * anywhere in it.
 */
interface ChartCodes {
  cash: string;
  sales: string;
  tax: string;
  cogs: string;
  inventory: string;
  overShort: string;
}

/** Holt's own chart — the codes the old hardcoded classifier understood. */
const HOLT_CHART: ChartCodes = {
  cash: "1-1006",
  sales: "4-4080",
  tax: "2-2120",
  cogs: "5-5280",
  inventory: "1-1380",
  overShort: "5-5900",
};

/**
 * A chart that shares NOTHING with Holt's numbering: no leading digit-dash
 * segment, nothing starting with "4-", no "2-2120", no "1-1006". Under the
 * old code-prefix classifier every bucket here reads $0.00 — which against
 * $0.00 of nothing looks exactly like a clean day.
 */
const ALIEN_CHART: ChartCodes = {
  cash: "BANK-001",
  sales: "SALES-100",
  tax: "TAX-PAYABLE",
  cogs: "COGS-500",
  inventory: "STOCK-900",
  overShort: "SUSPENSE-001",
};

/**
 * Wires a chart into the configuration the reconciliation actually reads:
 * an AccountGroup naming the sales + COGS accounts (per-department, which is
 * precisely why they cannot be single SystemGLMapping rows), a TaxDistrict
 * naming the tax account, and SystemGLMapping rows for the two genuine
 * singletons.
 */
async function seedChart(codes: ChartCodes) {
  const cash = await ensureGlAccount(codes.cash, "Cash", "ASSET");
  const sales = await ensureGlAccount(codes.sales, "Sales", "REVENUE");
  const tax = await ensureGlAccount(codes.tax, "Sales Tax Payable", "LIABILITY");
  const cogs = await ensureGlAccount(codes.cogs, "COGS", "EXPENSE");
  const inventory = await ensureGlAccount(codes.inventory, "Inventory", "ASSET");
  const overShort = await ensureGlAccount(codes.overShort, "Cash Over/Short", "EXPENSE");

  await prisma.accountGroup.create({
    data: {
      name: "Furniture",
      salesAccountId: sales.id,
      cogsAccountId: cogs.id,
      inventoryAccountId: inventory.id,
    },
  });
  await prisma.taxDistrict.create({
    data: { shortName: "CT", state: "CT", name: "Connecticut", glAccountId: tax.id },
  });
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "POS_PAYMENTS", label: "Cash", glAccountId: cash.id },
      { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: tax.id },
      { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: overShort.id },
    ],
  });

  return { cash, sales, tax, cogs, inventory, overShort };
}

/**
 * Seed a POSTED JournalEntry on DAY with the given line shape. Each
 * line is { code, debit?, credit? }. Uses upsert on the GLAccount so
 * codes can be reused across scenarios within one test.
 */
async function seedJournalEntry(
  lines: SeedJournalLineSpec[],
  status: "POSTED" | "EXPORTED" = "POSTED",
) {
  // Resolve all GL account FKs first.
  const accountMap = new Map<string, number>();
  for (const l of lines) {
    if (!accountMap.has(l.code)) {
      const acct = await ensureGlAccount(l.code, `Account ${l.code}`);
      accountMap.set(l.code, acct.id);
    }
  }
  const totalDebits = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredits = lines.reduce((s, l) => s + (l.credit ?? 0), 0);

  return prisma.journalEntry.create({
    data: {
      journalNumber: `JE-TEST-${Date.now()}`,
      journalDate: DAY,
      journalType: "SALES",
      status,
      totalDebits,
      totalCredits,
      lines: {
        create: lines.map((l, i) => ({
          glAccountId: accountMap.get(l.code)!,
          memo: `line ${i}`,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          sortOrder: i,
        })),
      },
    },
  });
}

describe("computeDailyReconciliation (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("hasJournalEntry=false + warning when no JE exists for the day", async () => {
    await seedChart(HOLT_CHART);
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "T1",
      customerId: customer.id,
      lines: [{ netPrice: 100, vatAmount: 6.35, cost: 40 }],
    });
    await seedPayment(106.35);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.hasJournalEntry).toBe(false);
    expect(result.balanced).toBe(false);
    expect(result.warnings[0]).toContain("No POSTED/EXPORTED journal entry");
    expect(result.source.revenue).toBe(100);
    expect(result.journal.revenue).toBe(0);
  });

  it("balanced=true when source and JE match", async () => {
    await seedChart(HOLT_CHART);
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "T1",
      customerId: customer.id,
      lines: [{ netPrice: 1000, vatAmount: 63.5, cost: 400 }],
    });
    await seedPayment(1063.5);
    await seedJournalEntry([
      { code: "1-1006", debit: 1063.5 }, // cash
      { code: "4-4080", credit: 1000 }, // revenue
      { code: "2-2120", credit: 63.5 }, // tax
      { code: "5-5280", debit: 400 }, // COGS
      { code: "1-1380", credit: 400 }, // inventory (not summed in any of the 4 buckets)
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.hasJournalEntry).toBe(true);
    expect(result.balanced).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.source).toMatchObject({ revenue: 1000, tax: 63.5, cost: 400, cash: 1063.5 });
    expect(result.journal).toMatchObject({ revenue: 1000, tax: 63.5, cost: 400, cash: 1063.5 });
  });

  it("revenue drift flagged when JE missed line items", async () => {
    await seedChart(HOLT_CHART);
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "T1",
      customerId: customer.id,
      lines: [{ netPrice: 1000, vatAmount: 63.5, cost: 400 }],
    });
    await seedPayment(1063.5);
    await seedJournalEntry([
      { code: "1-1006", debit: 1063.5 },
      { code: "4-4080", credit: 950 }, // $50 short
      { code: "2-2120", credit: 63.5 },
      { code: "5-5280", debit: 400 },
      { code: "1-1380", credit: 400 }, // inventory relief for the COGS debit
      // The $50 of revenue the entry failed to recognize still arrived as cash,
      // so a real posted entry closes it to Over/Short rather than not balancing.
      { code: "5-5900", credit: 50 },
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.balanced).toBe(false);
    expect(result.drift.revenue).toBe(50);
    expect(result.warnings.some((w) => w.includes("Revenue drift"))).toBe(true);
  });

  it("return-day shape: negative source amounts balance against negative JE", async () => {
    await seedChart(HOLT_CHART);
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "RET1",
      status: "RETURNED",
      customerId: customer.id,
      lines: [{ netPrice: -500, vatAmount: -31.75, cost: -200 }],
    });
    await seedPayment(-531.75);
    await seedJournalEntry([
      { code: "1-1006", credit: 531.75 }, // cash out
      { code: "4-4080", debit: 500 }, // revenue reversed
      { code: "2-2120", debit: 31.75 }, // tax reversed
      { code: "5-5280", credit: 200 }, // COGS reversed
      { code: "1-1380", debit: 200 }, // ...and the goods land back in inventory
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.source).toMatchObject({ revenue: -500, tax: -31.75, cost: -200, cash: -531.75 });
    expect(result.journal.revenue).toBe(-500);
    expect(result.journal.cash).toBe(-531.75);
    expect(result.balanced).toBe(true);
  });

  it("sums revenue and COGS across EVERY department's AccountGroup", async () => {
    // Revenue and COGS are per-department: one sales account and one COGS
    // account per AccountGroup, which is exactly why a single
    // SystemGLMapping row cannot name them. Both departments' accounts must
    // land in the bucket, and the department's inventory account must not.
    await seedChart(HOLT_CHART);
    const homeSales = await ensureGlAccount("4-4010", "Sales: Home Acc", "REVENUE");
    const homeCogs = await ensureGlAccount("5-5210", "COGS: Home Acc", "EXPENSE");
    const homeInventory = await ensureGlAccount("1-1310", "Inventory: Home Acc", "ASSET");
    await prisma.accountGroup.create({
      data: {
        name: "Home Acc",
        salesAccountId: homeSales.id,
        cogsAccountId: homeCogs.id,
        inventoryAccountId: homeInventory.id,
      },
    });

    await seedJournalEntry([
      { code: "1-1006", debit: 106.35 }, // cash: revenue + tax, as collected
      { code: "4-4010", credit: 50 }, // home acc revenue
      { code: "4-4080", credit: 50 }, // furniture revenue
      { code: "2-2120", credit: 6.35 }, // CT tax
      { code: "5-5210", debit: 20 }, // home acc COGS
      { code: "1-1310", credit: 20 }, // home acc inventory — in no bucket
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.journal.cash).toBe(106.35);
    expect(result.journal.revenue).toBe(100); // both departments
    expect(result.journal.tax).toBe(6.35);
    expect(result.journal.cost).toBe(20);
    expect(result.journal.overShort).toBe(0);
  });

  it("sums tax across EVERY TaxDistrict, not just the one the code literal named", async () => {
    // The old classifier tested `code === "2-2120"` with a comment reading
    // "CT Sales Tax Payable". A second state's district was silently dropped.
    await seedChart(HOLT_CHART);
    const nyTax = await ensureGlAccount("2-2121", "NY Sales Tax Payable", "LIABILITY");
    await prisma.taxDistrict.create({
      data: { shortName: "NY", state: "NY", name: "New York", glAccountId: nyTax.id },
    });

    await seedJournalEntry([
      { code: "1-1006", debit: 116.35 },
      { code: "4-4080", credit: 100 },
      { code: "2-2120", credit: 6.35 }, // CT
      { code: "2-2121", credit: 10 }, // NY — dropped entirely before this change
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.journal.tax).toBe(16.35);
  });

  // === Real-DB-only scenarios mocks couldn't catch ===

  it("(REAL-DB) excludes CANCELLED line items from source revenue (rule 33)", async () => {
    await seedChart(HOLT_CHART);
    // The mocked test asserted the function CALLED findMany with the
    // cancelled-line filter. This asserts the filter actually works
    // against real Postgres data — including the typo guard
    // (CANCELED vs CANCELLED) and case folding.
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "MIXED",
      customerId: customer.id,
      lines: [
        { netPrice: 1000, vatAmount: 63.5, cost: 400, lineItemStatus: "ACTIVE" },
        { netPrice: 9999, vatAmount: 999, cost: 5000, lineItemStatus: "CANCELLED" },
      ],
    });

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.source.revenue).toBe(1000);
    expect(result.source.cost).toBe(400);
    // The cancelled $9999 / $5000 cost line was excluded — exactly
    // the bug shape that bit the detailed-sales report in April.
  });

  it("(REAL-DB) excludes orders outside the date window", async () => {
    await seedChart(HOLT_CHART);
    // Source-side date filter: only orders with orderDate in the
    // requested day should count. Mocked tests can't verify this
    // because the mock just returns whatever you hand it.
    const customer = await seedCustomer();
    // In-window order
    await seedOrder({
      orderno: "TODAY",
      customerId: customer.id,
      lines: [{ netPrice: 100, vatAmount: 6.35, cost: 40 }],
    });
    // Out-of-window: yesterday
    await prisma.salesOrder.create({
      data: {
        orderno: "YESTERDAY",
        status: "ORDER",
        orderDate: new Date("2026-04-27T00:00:00Z"),
        customerId: customer.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 9999,
              vatAmount: 600,
              cost: 5000,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.source.revenue).toBe(100);
    // The yesterday order's $9999 didn't leak in.
  });

  it("(REAL-DB) excludes CANCELLED-status orders from source", async () => {
    await seedChart(HOLT_CHART);
    // Beyond the line-item filter: the order itself must be in
    // ORDER/FULFILLED/RETURNED. A CANCELLED order with active line
    // items must not contribute.
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "CANCELLED_ORDER",
      status: "CANCELLED",
      customerId: customer.id,
      lines: [{ netPrice: 9999, vatAmount: 600, cost: 5000 }],
    });

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.source.revenue).toBe(0);
  });

  // ─── The plug is not revenue ────────────────────────────────────

  describe("Over/Short plug", () => {
    /** A day whose JE only balances because a `plug` was posted to Over/Short. */
    async function seedPluggedDay(plug: number) {
      const customer = await seedCustomer();
      await seedOrder({
        orderno: "T1",
        customerId: customer.id,
        lines: [{ netPrice: 1000, vatAmount: 63.5, cost: 400 }],
      });
      await seedPayment(1063.5);
      await seedJournalEntry([
        { code: HOLT_CHART.cash, debit: 1063.5 },
        { code: HOLT_CHART.sales, credit: 1000 },
        { code: HOLT_CHART.tax, credit: 63.5 },
        { code: HOLT_CHART.cogs, debit: 400 },
        // The inventory relief came up `plug` short and nobody found the
        // difference, so Over/Short was posted to force the entry to balance --
        // which is what the docstring above claims and what these legs did not
        // do: all six balanced on their own, so the plug CREATED an imbalance
        // instead of closing one, and the entry could never have posted.
        //
        // The shortfall sits in inventory deliberately. Inventory is in none of
        // the four reconciled buckets, so cash, revenue, tax and cost all still
        // tie to source and the plug is graded only against
        // OVER_SHORT_ALERT_THRESHOLD -- which is the distinction these two tests
        // exist to draw.
        { code: HOLT_CHART.inventory, credit: 400 - plug },
        { code: HOLT_CHART.overShort, credit: plug },
      ]);
    }

    it("reports the plug as its own figure and keeps it out of revenue", async () => {
      await seedChart(HOLT_CHART);
      await seedPluggedDay(12000);

      const result = await computeDailyReconciliation({
        date: DAY,
        timeZone: "UTC",
        client: prisma,
      });

      // The whole point: a human reads "plug: $12,000", not "revenue drift".
      expect(result.journal.overShort).toBe(12000);
      expect(result.journal.revenue).toBe(1000);
      expect(result.drift.revenue).toBe(0);
      expect(result.balanced).toBe(false);
      expect(result.warnings.some((w) => w.includes("Over/Short plug $12000.00"))).toBe(true);
      // ...and nothing points the operator at the orders, where the problem
      // is not. Before this change the $12,000 landed in journal.revenue
      // (Over/Short was a "4-" account, seeded as type REVENUE), producing a
      // $12,000 revenue drift and a fruitless hunt through the day's sales.
      expect(result.warnings.some((w) => w.includes("Revenue drift"))).toBe(false);
    });

    it("does not turn the day amber for a rounding-sized plug", async () => {
      await seedChart(HOLT_CHART);
      await seedPluggedDay(0.02);

      const result = await computeDailyReconciliation({
        date: DAY,
        timeZone: "UTC",
        client: prisma,
      });
      // Reported, so it is on the record and in the log column...
      expect(result.journal.overShort).toBe(0.02);
      // ...but $0.02 of rounding is not an incident.
      expect(result.balanced).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });

  // ─── Missing configuration is never a clean day ─────────────────

  describe("missing GL configuration", () => {
    it("warns per missing mapping instead of silently reporting zero", async () => {
      // No AccountGroup, no TaxDistrict, no SystemGLMapping. Every bucket
      // resolves to $0.00 — which against a day with no source rows drifts
      // by nothing at all. Reporting "balanced" here is the exact silent
      // success this control exists to prevent.
      await seedJournalEntry([
        { code: "SOMETHING-1", debit: 500 },
        { code: "SOMETHING-2", credit: 500 }, // also unmapped — every bucket stays $0.00
      ]);

      const result = await computeDailyReconciliation({
        date: DAY,
        timeZone: "UTC",
        client: prisma,
      });

      expect(result.balanced).toBe(false);
      expect(result.warnings.some((w) => w.includes("sales GL account"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("COGS GL account"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("tax GL account"))).toBe(true);
      expect(result.warnings.some((w) => w.includes('POS_PAYMENTS/"Cash"'))).toBe(true);
    });

    it("names the Over/Short account doubling as a sales account", async () => {
      // The misconfiguration that started all this: a plug account wired
      // where revenue is recognized launders plugs into the P&L.
      const sales = await ensureGlAccount("4-4080", "Sales", "REVENUE");
      const cogs = await ensureGlAccount("5-5280", "COGS", "EXPENSE");
      const cash = await ensureGlAccount("1-1006", "Cash", "ASSET");
      const tax = await ensureGlAccount("2-2120", "Tax", "LIABILITY");
      await prisma.accountGroup.create({
        data: { name: "Furniture", salesAccountId: sales.id, cogsAccountId: cogs.id },
      });
      await prisma.systemGLMapping.createMany({
        data: [
          { section: "POS_PAYMENTS", label: "Cash", glAccountId: cash.id },
          { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: tax.id },
          // Same account as the department's revenue GL.
          { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: sales.id },
        ],
      });
      await seedJournalEntry([
        { code: "1-1006", debit: 500 }, // the overage arrived as cash
        { code: "4-4080", credit: 500 },
      ]);

      const result = await computeDailyReconciliation({
        date: DAY,
        timeZone: "UTC",
        client: prisma,
      });

      expect(result.warnings.some((w) => w.includes("also configured as a department"))).toBe(true);
      // Over/Short is tested first, so the amount reports as a plug rather
      // than being laundered into revenue.
      expect(result.journal.overShort).toBe(500);
      expect(result.journal.revenue).toBe(0);
      expect(result.balanced).toBe(false);
    });
  });
});

// ─── The inversion: a chart with none of Holt's numbering ─────────
//
// This is the proof that the code literals are really gone. Every scenario
// below is byte-for-byte the same as one run against HOLT_CHART above; only
// the account CODES differ, and none of them starts with "4-", equals
// "2-2120", starts with "5-52", or equals "1-1006". Under the previous
// classifier all four buckets would read $0.00 and — against $0.00 of
// journal — the day would report perfectly balanced.

describe("computeDailyReconciliation — alien chart of accounts (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** The shared scenario, run against whichever chart is passed in. */
  async function runSaleDay(chart: ChartCodes) {
    await seedChart(chart);
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "T1",
      customerId: customer.id,
      lines: [{ netPrice: 1000, vatAmount: 63.5, cost: 400 }],
    });
    await seedPayment(1063.5);
    await seedJournalEntry([
      { code: chart.cash, debit: 1063.5 },
      { code: chart.sales, credit: 1000 },
      { code: chart.tax, credit: 63.5 },
      { code: chart.cogs, debit: 400 },
      { code: chart.inventory, credit: 400 },
    ]);
    return computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
  }

  it("reconciles a sale day identically to Holt's own chart", async () => {
    const alien = await runSaleDay(ALIEN_CHART);

    expect(alien.balanced).toBe(true);
    expect(alien.warnings).toEqual([]);
    expect(alien.journal).toMatchObject({
      revenue: 1000,
      tax: 63.5,
      cost: 400,
      cash: 1063.5,
      overShort: 0,
    });
    expect(alien.drift).toEqual({ revenue: 0, tax: 0, cost: 0, cash: 0 });
  });

  it("produces figures equal to Holt's chart for the same journal", async () => {
    // Equivalence stated as an assertion rather than as two hand-copied
    // literal sets: same scenario, two charts, identical numbers.
    const alien = await runSaleDay(ALIEN_CHART);
    await resetTestDb();
    const holt = await runSaleDay(HOLT_CHART);

    expect(alien.journal).toEqual(holt.journal);
    expect(alien.source).toEqual(holt.source);
    expect(alien.drift).toEqual(holt.drift);
    expect(alien.balanced).toBe(holt.balanced);
  });

  it("still catches drift on an alien chart", async () => {
    // A classifier that matched nothing would also report zero drift. Prove
    // the buckets are genuinely populated by breaking one.
    await seedChart(ALIEN_CHART);
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "T1",
      customerId: customer.id,
      lines: [{ netPrice: 1000, vatAmount: 63.5, cost: 400 }],
    });
    await seedPayment(1063.5);
    await seedJournalEntry([
      { code: ALIEN_CHART.cash, debit: 1063.5 },
      { code: ALIEN_CHART.sales, credit: 950 }, // $50 short
      { code: ALIEN_CHART.tax, credit: 63.5 },
      { code: ALIEN_CHART.cogs, debit: 400 },
      { code: ALIEN_CHART.inventory, credit: 400 },
      { code: ALIEN_CHART.overShort, credit: 50 },
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.drift.revenue).toBe(50);
    expect(result.balanced).toBe(false);
    expect(result.warnings.some((w) => w.includes("Revenue drift"))).toBe(true);
  });

  it("reports an alien chart's plug as a plug, not as revenue", async () => {
    await seedChart(ALIEN_CHART);
    await seedJournalEntry([
      { code: ALIEN_CHART.cash, debit: 6000 }, // $1,000 of sales + a $5,000 overage
      { code: ALIEN_CHART.sales, credit: 1000 },
      { code: ALIEN_CHART.overShort, credit: 5000 },
    ]);

    const result = await computeDailyReconciliation({ date: DAY, timeZone: "UTC", client: prisma });
    expect(result.journal.overShort).toBe(5000);
    expect(result.journal.revenue).toBe(1000);
    expect(result.balanced).toBe(false);
  });
});
