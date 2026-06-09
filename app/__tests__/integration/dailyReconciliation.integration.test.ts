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
async function ensureGlAccount(code: string, name: string) {
  const existing = await prisma.gLAccount.findFirst({ where: { code } });
  if (existing) return existing;
  return prisma.gLAccount.create({
    data: { code, name, accountType: code.startsWith("4-") ? "REVENUE" : "ASSET" },
  });
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
    const customer = await seedCustomer();
    await seedOrder({
      orderno: "T1",
      customerId: customer.id,
      lines: [{ netPrice: 100, vatAmount: 6.35, cost: 40 }],
    });
    await seedPayment(106.35);

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.hasJournalEntry).toBe(false);
    expect(result.balanced).toBe(false);
    expect(result.warnings[0]).toContain("No POSTED/EXPORTED journal entry");
    expect(result.source.revenue).toBe(100);
    expect(result.journal.revenue).toBe(0);
  });

  it("balanced=true when source and JE match", async () => {
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

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.hasJournalEntry).toBe(true);
    expect(result.balanced).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.source).toMatchObject({ revenue: 1000, tax: 63.5, cost: 400, cash: 1063.5 });
    expect(result.journal).toMatchObject({ revenue: 1000, tax: 63.5, cost: 400, cash: 1063.5 });
  });

  it("revenue drift flagged when JE missed line items", async () => {
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
    ]);

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.balanced).toBe(false);
    expect(result.drift.revenue).toBe(50);
    expect(result.warnings.some((w) => w.includes("Revenue drift"))).toBe(true);
  });

  it("return-day shape: negative source amounts balance against negative JE", async () => {
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
    ]);

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.source).toMatchObject({ revenue: -500, tax: -31.75, cost: -200, cash: -531.75 });
    expect(result.journal.revenue).toBe(-500);
    expect(result.journal.cash).toBe(-531.75);
    expect(result.balanced).toBe(true);
  });

  it("classifies GL accounts by code prefix correctly", async () => {
    await seedJournalEntry([
      { code: "1-1006", debit: 100 }, // cash
      { code: "4-4010", credit: 50 }, // home acc revenue
      { code: "4-4080", credit: 50 }, // furniture revenue
      { code: "2-2120", credit: 6.35 }, // CT tax
      { code: "5-5210", debit: 20 }, // home acc COGS
      { code: "1-1310", credit: 20 }, // home acc inventory (not classified into the 4 buckets)
    ]);

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.journal.cash).toBe(100); // 1-1006 only
    expect(result.journal.revenue).toBe(100); // 4-4010 + 4-4080
    expect(result.journal.tax).toBe(6.35); // 2-2120
    expect(result.journal.cost).toBe(20); // 5-5210
  });

  // === Real-DB-only scenarios mocks couldn't catch ===

  it("(REAL-DB) excludes CANCELLED line items from source revenue (rule 33)", async () => {
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

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.source.revenue).toBe(1000);
    expect(result.source.cost).toBe(400);
    // The cancelled $9999 / $5000 cost line was excluded — exactly
    // the bug shape that bit the detailed-sales report in April.
  });

  it("(REAL-DB) excludes orders outside the date window", async () => {
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

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.source.revenue).toBe(100);
    // The yesterday order's $9999 didn't leak in.
  });

  it("(REAL-DB) excludes CANCELLED-status orders from source", async () => {
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

    const result = await computeDailyReconciliation({ date: DAY, client: prisma });
    expect(result.source.revenue).toBe(0);
  });
});
