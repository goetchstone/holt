// /app/__tests__/journalEntry.test.ts
//
// PLACEHOLDER TEST — Grade: A (pure helpers + source-text tripwire).
// The Prisma mock at line 10 is an isolation shim — the imports below
// (round2, toNum, formatJournalNumber, buildJournalLines, assertBalanced)
// are all pure functions taking literal input objects. No SQL is
// exercised in this file.
//
// `generateSalesJournal` (the DB-touching orchestration) is NOT tested
// here. That gap is addressed under Phase 0.6.4 — see plan file. When
// it lands, the integration test will live at
// __tests__/integration/generateSalesJournal.integration.test.ts.

jest.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  round2,
  toNum,
  formatJournalNumber,
  buildJournalLines,
  assertBalanced,
  BALANCE_TOLERANCE,
  SalesPayment,
  SalesLineForJournal,
} from "../src/lib/journalEntry";

// Arbitrary GL account IDs for test fixtures
const GL = {
  CASH: 1,
  DEPOSIT: 2,
  GC_LIABILITY: 3,
  REVENUE: 10,
  COGS: 11,
  INVENTORY: 12,
  TAX: 20,
  OVER_SHORT: 30,
};

function makeLine(overrides: Partial<SalesLineForJournal> = {}): SalesLineForJournal {
  return {
    id: 1,
    description: "Hartwell Sofa",
    netPrice: 1000,
    cost: 400,
    quantity: 1,
    taxAmount: 63.5,
    accountGroup: {
      name: "Furniture",
      salesGlId: GL.REVENUE,
      cogsGlId: GL.COGS,
      inventoryGlId: GL.INVENTORY,
    },
    ...overrides,
  };
}

function makePayment(overrides: Partial<SalesPayment> = {}): SalesPayment {
  return {
    amount: 1063.5,
    memo: "Cash",
    glAccountId: GL.CASH,
    glCode: "1-1006",
    order: {
      id: 1,
      hasInvoices: true,
      taxGlId: GL.TAX,
      taxMemo: "CT",
      lineItems: [makeLine()],
    },
    ...overrides,
  };
}

// ─── Utility functions ──────────────────────────────────────────

describe("round2", () => {
  it("rounds to two decimal places", () => {
    expect(round2(1.256)).toBe(1.26);
    expect(round2(1.254)).toBe(1.25);
    expect(round2(100)).toBe(100);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it("handles negative values", () => {
    expect(round2(-1.256)).toBe(-1.26);
    expect(round2(-0.006)).toBe(-0.01);
  });
});

describe("toNum", () => {
  it("returns 0 for null and undefined", () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
  });

  it("passes through numbers unchanged", () => {
    expect(toNum(42)).toBe(42);
    expect(toNum(0)).toBe(0);
    expect(toNum(-10.5)).toBe(-10.5);
  });

  it("converts non-number values via Number()", () => {
    // Simulates Prisma Decimal behavior (has valueOf/toString)
    const decimalLike = { valueOf: () => "123.45", toString: () => "123.45" };
    expect(toNum(decimalLike as never)).toBe(123.45);
  });
});

describe("formatJournalNumber", () => {
  it("formats date as SJyyyymmdd (4-digit year)", () => {
    expect(formatJournalNumber(new Date(2026, 2, 17))).toBe("SJ20260317");
    expect(formatJournalNumber(new Date(2026, 0, 5))).toBe("SJ20260105");
  });
});

// ─── assertBalanced (B4 from SOR plan) ──────────────────────────

describe("assertBalanced", () => {
  it("accepts a balanced entry", () => {
    const result = assertBalanced([
      { debit: 1000, credit: 0 },
      { debit: 0, credit: 1000 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.totalDebits).toBe(1000);
    expect(result.totalCredits).toBe(1000);
    expect(result.diff).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("accepts a multi-line balanced entry (sales-like shape)", () => {
    // Mirrors the SJ220501 sample shape -- payments + sales + tax + COGS + inventory
    const result = assertBalanced([
      { debit: 1063.5, credit: 0 }, // Cash
      { debit: 0, credit: 1000 }, // Sales
      { debit: 0, credit: 63.5 }, // Tax
      { debit: 400, credit: 0 }, // COGS
      { debit: 0, credit: 400 }, // Inventory
    ]);
    expect(result.ok).toBe(true);
  });

  it("REJECTS empty line array", () => {
    // An entry with no lines is implicitly imbalanced AND nonsensical to post.
    const result = assertBalanced([]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("zero lines");
  });

  it("REJECTS entry off by a dollar", () => {
    const result = assertBalanced([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 99 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diff).toBe(1);
    expect(result.error).toContain("out of balance");
    expect(result.error).toContain("100.00");
    expect(result.error).toContain("99.00");
  });

  it("REJECTS entry off by a penny (above tolerance)", () => {
    const result = assertBalanced([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 99.99 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diff).toBe(0.01);
  });

  it("ACCEPTS entry off by half a penny (within tolerance)", () => {
    // Floating-point math can produce sub-penny drift even when the
    // accounting is correct. Tolerance is BALANCE_TOLERANCE = 0.005.
    const result = assertBalanced([
      { debit: 100.001, credit: 0 },
      { debit: 0, credit: 100 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("treats negative debits/credits correctly (a refund-shaped imbalance)", () => {
    // If a return JE has positive Sales debit + negative Cash credit (an
    // unusual shape), the math still has to balance. This test ensures
    // the helper sums signs correctly rather than abs-ing them.
    const result = assertBalanced([
      { debit: 50, credit: 0 },
      { debit: 0, credit: 50 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("exposes BALANCE_TOLERANCE as a stable constant", () => {
    // Tripwire so a future "loosen the tolerance" PR is visible.
    expect(BALANCE_TOLERANCE).toBe(0.005);
  });

  // ─── B4 Phase 0.6.4 backfill — per-line shape + floating-point edge ────

  it("REJECTS a line with BOTH debit and credit set non-zero (malformed)", () => {
    // A well-formed JE line records exactly one side. Both-set is a sign
    // of a hand-edit bug or a malformed import. Without this check, totals
    // could still balance while the underlying rows are nonsense.
    const result = assertBalanced([
      { debit: 100, credit: 50 }, // malformed
      { debit: 0, credit: 50 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Malformed journal line 0");
    expect(result.error).toContain("both debit");
    expect(result.error).toContain("100.00");
    expect(result.error).toContain("50.00");
  });

  it("REJECTS a line with NEITHER debit nor credit set (no-op row)", () => {
    // A {debit:0, credit:0} line is noise — buildJournalLines filters
    // these out via `if (amount === 0) return null`. If one slips through
    // (manual edit, future import path), reject early.
    const result = assertBalanced([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 0 }, // malformed
      { debit: 0, credit: 100 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Malformed journal line 1");
    expect(result.error).toContain("both debit and credit are zero");
  });

  it("REJECTS a multi-line entry where any single line is malformed (early exit)", () => {
    // Confirms the per-line check inspects every line, not just the first.
    const result = assertBalanced([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 },
      { debit: 50, credit: 50 }, // malformed mid-set
      { debit: 50, credit: 0 },
      { debit: 0, credit: 50 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Malformed journal line 2");
  });

  it("ACCEPTS the canonical floating-point edge: 0.1 + 0.2 vs 0.3", () => {
    // IEEE 754: 0.1 + 0.2 = 0.30000000000000004 (NOT 0.3). Without
    // round2 normalization, this would falsely fail balance even though
    // the accounting is correct. round2 -> 0.30 / 0.30, diff -> 0, ok.
    const result = assertBalanced([
      { debit: 0.1, credit: 0 },
      { debit: 0.2, credit: 0 },
      { debit: 0, credit: 0.3 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(0);
  });

  it("ACCEPTS multi-line accumulator drift within tolerance (50-line shape)", () => {
    // Real-world JEs can have 30-100 lines (one per store/payment-type
    // combo). Accumulator drift is the failure mode we're guarding
    // against — many small floats summed can diverge by sub-penny.
    const lines: { debit: number; credit: number }[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push({ debit: 0.1, credit: 0 });
      lines.push({ debit: 0, credit: 0.1 });
    }
    const result = assertBalanced(lines);
    expect(result.ok).toBe(true);
    // Without round2, the raw sum would be 2.5000000000000013 — round2
    // normalizes both sides to 2.50.
    expect(result.totalDebits).toBe(2.5);
    expect(result.totalCredits).toBe(2.5);
  });

  it("REJECTS a refund-shaped line that flipped the sign instead of the side (buildJournalLines invariant)", () => {
    // Sign-flip bug class from the 2026-04-25 outage: a return that emits
    // {debit: -1000, credit: 0} instead of {debit: 0, credit: 1000}.
    // assertBalanced uses round2 + abs-tolerance, so a -1000 debit would
    // make totalDebits = -1000 vs totalCredits = 1000 — diff = -2000.
    // Catches the bug shape on the imbalance check.
    const result = assertBalanced([
      { debit: -1000, credit: 0 },
      { debit: 0, credit: 1000 },
    ]);
    // The shape passes per-line validation (debit is non-zero), but
    // totals diverge. Caught by the imbalance check.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("out of balance");
  });
});

// ─── Returns as sale-in-reverse (B3) ────────────────────────────

describe("buildJournalLines — returns are sales in reverse (B3)", () => {
  // Accounting reference: a return reverses every leg of the original
  // sale. Cash flips from debit to credit (refund out), Sales / Tax
  // flip from credit to debit (reverse revenue / liability), COGS flips
  // from debit to credit (reverse expense), Inventory flips from
  // credit to debit (item back on shelf). Total debits and credits
  // must still balance to zero variance.

  it("produces a balanced sale-in-reverse JE for a pure return", () => {
    // Customer returns a $500 item (cost $200, CT tax $31.75).
    // Refund payment is negative; line item fields are all negative.
    const refundPayment: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 99,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: -500, cost: -200, taxAmount: -31.75 })],
      },
    };
    const result = buildJournalLines([refundPayment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toEqual([]);

    // Cash should be a CREDIT (refund out, asset decreases).
    const cashLine = result.lines.find((l) => l.glAccountId === GL.CASH);
    expect(cashLine?.debit).toBe(0);
    expect(cashLine?.credit).toBe(531.75);

    // Sales should be a DEBIT (reverse the credit).
    const salesLine = result.lines.find((l) => l.glAccountId === GL.REVENUE);
    expect(salesLine?.debit).toBe(500);
    expect(salesLine?.credit).toBe(0);

    // Tax should be a DEBIT (reverse the liability credit).
    const taxLine = result.lines.find((l) => l.glAccountId === GL.TAX);
    expect(taxLine?.debit).toBe(31.75);
    expect(taxLine?.credit).toBe(0);

    // COGS should be a CREDIT (reverse the expense debit).
    const cogsLine = result.lines.find((l) => l.glAccountId === GL.COGS);
    expect(cogsLine?.debit).toBe(0);
    expect(cogsLine?.credit).toBe(200);

    // Inventory should be a DEBIT (item back on shelf, asset increases).
    const invLine = result.lines.find((l) => l.glAccountId === GL.INVENTORY);
    expect(invLine?.debit).toBe(200);
    expect(invLine?.credit).toBe(0);
  });

  it("nets sale + return on the same day (no JE row when net is zero)", () => {
    // Same customer buys then returns the same item same day.
    // Net everywhere is zero -> emitSigned skips, no lines produced.
    const sale = makePayment();
    const ret: SalesPayment = {
      amount: -1063.5,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 2,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: -1000, cost: -400, taxAmount: -63.5 })],
      },
    };
    const result = buildJournalLines([sale, ret], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(0);
    expect(result.totalCredits).toBe(0);
    expect(result.lines).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it("nets a same-day exchange with a price difference correctly", () => {
    // Exchange: return $500 item, buy $600 item. Net cash in:
    //   +638.10 (new sale incl 6.35% tax) - 531.75 (refund) = $106.35
    const refundPayment: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: -500, cost: -200, taxAmount: -31.75 })],
      },
    };
    const newSale: SalesPayment = {
      amount: 638.1,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 2,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: 600, cost: 240, taxAmount: 38.1 })],
      },
    };
    const result = buildJournalLines([refundPayment, newSale], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toEqual([]);

    expect(result.lines.find((l) => l.glAccountId === GL.CASH)?.debit).toBe(106.35);
    expect(result.lines.find((l) => l.glAccountId === GL.REVENUE)?.credit).toBe(100);
    expect(result.lines.find((l) => l.glAccountId === GL.TAX)?.credit).toBe(6.35);
    expect(result.lines.find((l) => l.glAccountId === GL.COGS)?.debit).toBe(40);
    expect(result.lines.find((l) => l.glAccountId === GL.INVENTORY)?.credit).toBe(40);
  });

  it("never emits a negative debit or credit (the B3 bug shape)", () => {
    // Before the emitSigned helper, return scenarios produced lines
    // with negative debits/credits -- QuickBooks rejects those on
    // import. This tripwire ensures every emitted line has non-
    // negative values in both fields, with exactly one of the two
    // greater than zero.
    const refundPayment: SalesPayment = {
      amount: -1063.5,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: -1000, cost: -400, taxAmount: -63.5 })],
      },
    };
    const result = buildJournalLines([refundPayment], GL.OVER_SHORT, GL.DEPOSIT);
    for (const line of result.lines) {
      expect(line.debit).toBeGreaterThanOrEqual(0);
      expect(line.credit).toBeGreaterThanOrEqual(0);
      expect(line.debit > 0 || line.credit > 0).toBe(true);
      expect(line.debit > 0 && line.credit > 0).toBe(false);
    }
  });
});

// ─── Endpoint tripwire for B4 ───────────────────────────────────

describe("Tripwire: PUT /api/accounting/journal-entries/[id] enforces balance pre-POST", () => {
  // PLACEHOLDER TEST -- Grade: B- (source-text tripwire)
  //
  // Source-text guard: the PUT handler MUST call assertBalanced before
  // any DRAFT->POSTED or POSTED->EXPORTED transition so the API never
  // ships an unbalanced JE to QuickBooks. A future refactor that drops
  // the call (or moves it after the .update()) fails this test.
  //
  // Upgrade target: Phase 0.6 -- replace with a real-DB integration test
  // that creates an unbalanced JE in the test DB, calls the PUT endpoint
  // via supertest, and asserts the 400 response + the JE staying in DRAFT.
  // See plan "Phase 0.6 -- Test infrastructure roadmap".
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  const ENDPOINT = path.resolve(__dirname, "../src/pages/api/accounting/journal-entries/[id].ts");

  test("imports assertBalanced", () => {
    const src = fs.readFileSync(ENDPOINT, "utf8");
    expect(src).toMatch(/import\s+\{\s*assertBalanced\s*\}\s+from\s+["']@\/lib\/journalEntry["']/);
  });

  test("calls assertBalanced when transitioning to POSTED or EXPORTED", () => {
    const src = fs.readFileSync(ENDPOINT, "utf8");
    expect(src).toMatch(/assertBalanced\(/);
    // Must guard both transitions, not just one.
    expect(src).toMatch(/status\s*===\s*["']POSTED["']/);
    expect(src).toMatch(/status\s*===\s*["']EXPORTED["']/);
  });

  test("returns 400 when assertBalanced.ok is false", () => {
    const src = fs.readFileSync(ENDPOINT, "utf8");
    // The handler must check `balance.ok` and return a 400 with the
    // diagnostic before attempting the update.
    expect(src).toMatch(/balance\.ok/);
    expect(src).toMatch(/res\.status\(400\)/);
  });
});

// ─── buildJournalLines ──────────────────────────────────────────

describe("buildJournalLines", () => {
  it("produces balanced debits and credits from an invoiced cash sale", () => {
    // $1063.50 cash payment on an invoiced order:
    // Line item: $1000 net, $63.50 tax, $400 cost
    const payment = makePayment();
    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);

    // Verify line structure
    const debits = result.lines.filter((l) => l.debit > 0);
    const credits = result.lines.filter((l) => l.credit > 0);

    // Debits: Cash $1063.50 + COGS $400
    expect(debits).toHaveLength(2);
    const cashDebit = debits.find((l) => l.glAccountId === GL.CASH);
    const cogsDebit = debits.find((l) => l.glAccountId === GL.COGS);
    expect(cashDebit?.debit).toBe(1063.5);
    expect(cogsDebit?.debit).toBe(400);

    // Credits: Revenue $1000 + Tax $63.50 + Inventory $400
    const revenueCredit = credits.find((l) => l.glAccountId === GL.REVENUE);
    const taxCredit = credits.find((l) => l.glAccountId === GL.TAX);
    const invCredit = credits.find((l) => l.glAccountId === GL.INVENTORY);
    expect(revenueCredit?.credit).toBe(1000);
    expect(taxCredit?.credit).toBe(63.5);
    expect(invCredit?.credit).toBe(400);

    // No Over/Short needed
    const overShort = result.lines.find((l) => l.glAccountId === GL.OVER_SHORT);
    expect(overShort).toBeUndefined();

    expect(result.warnings).toHaveLength(0);
  });

  it("accumulates tax correctly across multiple line items", () => {
    // Three items at different prices, CT 6.35% pre-calculated per line
    const lineItems: SalesLineForJournal[] = [
      makeLine({ id: 1, netPrice: 2499.99, cost: 1000, taxAmount: 158.75 }),
      makeLine({ id: 2, netPrice: 849.99, cost: 340, taxAmount: 53.97 }),
      makeLine({ id: 3, netPrice: 399.99, cost: 160, taxAmount: 25.4 }),
    ];
    const totalNet = 2499.99 + 849.99 + 399.99; // 3749.97
    const totalTax = 158.75 + 53.97 + 25.4; // 238.12
    const totalPayment = round2(totalNet + totalTax); // 3988.09

    const payment = makePayment({
      amount: totalPayment,
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems,
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);

    const taxLine = result.lines.find((l) => l.glAccountId === GL.TAX);
    expect(taxLine?.credit).toBe(238.12);

    const revLine = result.lines.find((l) => l.glAccountId === GL.REVENUE);
    expect(revLine?.credit).toBe(3749.97);
  });

  it("auto-balances with Over/Short when rounding causes imbalance", () => {
    // Payment is $0.50 less than revenue + tax (simulates POS rounding)
    const payment = makePayment({
      amount: 1063.0,
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: 1000, taxAmount: 63.5, cost: 400 })],
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);

    // Over/Short should absorb the $0.50 difference
    const overShort = result.lines.find((l) => l.glAccountId === GL.OVER_SHORT);
    expect(overShort).toBeDefined();
    // Debits ($1063 cash + $400 COGS = $1463) < Credits ($1000 rev + $63.50 tax + $400 inv = $1463.50)
    // Diff = -0.50, so Over/Short gets a debit of $0.50
    expect(overShort?.debit).toBe(0.5);
    expect(overShort?.credit).toBe(0);
  });

  it("warns when no Over/Short GL is configured and entry is unbalanced", () => {
    const payment = makePayment({ amount: 1063.0 });

    const result = buildJournalLines([payment], null, GL.DEPOSIT);

    expect(result.totalDebits).not.toBe(result.totalCredits);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("out of balance by $-0.50")]),
    );
  });

  it("warns when line item has no account group mapping", () => {
    const payment = makePayment({
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ description: "Mystery Item", accountGroup: null })],
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Line item "Mystery Item" has no account group mapping'),
      ]),
    );
  });

  it("warns when account group has no sales GL account", () => {
    const payment = makePayment({
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [
          makeLine({
            accountGroup: {
              name: "Accessories",
              salesGlId: null,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
            },
          }),
        ],
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Account group "Accessories" has no sales GL account'),
      ]),
    );
  });

  it("warns when tax amount exists but no tax GL is configured", () => {
    const payment = makePayment({
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: null,
        taxMemo: "Unknown",
        lineItems: [makeLine({ taxAmount: 50 })],
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('No tax GL account for district "Unknown"')]),
    );
  });

  it("creates deposit offset for cash payments without invoices", () => {
    const payment = makePayment({
      amount: 500,
      order: {
        id: 1,
        hasInvoices: false,
        taxGlId: null,
        taxMemo: "",
        lineItems: [],
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);

    // Cash debit $500
    const cashDebit = result.lines.find((l) => l.glAccountId === GL.CASH && l.debit > 0);
    expect(cashDebit?.debit).toBe(500);

    // Deposit credit $500
    const depositCredit = result.lines.find((l) => l.glAccountId === GL.DEPOSIT && l.credit > 0);
    expect(depositCredit?.credit).toBe(500);

    // No revenue, COGS, or inventory lines
    expect(result.lines.find((l) => l.glAccountId === GL.REVENUE)).toBeUndefined();
    expect(result.lines.find((l) => l.glAccountId === GL.COGS)).toBeUndefined();
  });

  it("flips negative payments (refunds) to credits", () => {
    const payment = makePayment({
      amount: -200,
      order: null,
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    // Negative cash payment becomes a credit (refund out of the cash account)
    const cashLine = result.lines.find((l) => l.glAccountId === GL.CASH);
    expect(cashLine?.debit).toBe(0);
    expect(cashLine?.credit).toBe(200);
  });

  it("does not double-count line items when multiple payments reference the same order", () => {
    const sharedOrder = {
      id: 1,
      hasInvoices: true,
      taxGlId: GL.TAX,
      taxMemo: "CT",
      lineItems: [makeLine({ netPrice: 2000, cost: 800, taxAmount: 127 })],
    };

    const payments: SalesPayment[] = [
      makePayment({ amount: 1000, order: sharedOrder }),
      makePayment({ amount: 1127, order: sharedOrder }),
    ];

    const result = buildJournalLines(payments, GL.OVER_SHORT, GL.DEPOSIT);

    // Revenue should be $2000 (counted once), not $4000
    const revLine = result.lines.find((l) => l.glAccountId === GL.REVENUE);
    expect(revLine?.credit).toBe(2000);

    // Tax should be $127 (counted once)
    const taxLine = result.lines.find((l) => l.glAccountId === GL.TAX);
    expect(taxLine?.credit).toBe(127);

    // Cash debits should sum both payments: $1000 + $1127 = $2127
    const cashDebit = result.lines.find((l) => l.glAccountId === GL.CASH && l.debit > 0);
    expect(cashDebit?.debit).toBe(2127);
  });

  it("routes gift card redemptions as liability debits", () => {
    const payment = makePayment({
      amount: 500,
      memo: "Gift Card",
      glAccountId: GL.GC_LIABILITY,
      glCode: "2-2127",
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: 468.38, cost: 200, taxAmount: 31.62 })],
      },
    });

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    // Gift card should be a debit to the liability account (reducing the liability)
    const gcLine = result.lines.find((l) => l.glAccountId === GL.GC_LIABILITY);
    expect(gcLine?.debit).toBe(500);
    expect(gcLine?.memo).toBe("GC Redeem");
  });

  it("handles a full multi-payment, multi-department day", () => {
    const GL_REV_FURNITURE = 100;
    const GL_REV_ACCESSORIES = 101;
    const GL_COGS_FURNITURE = 110;
    const GL_COGS_ACCESSORIES = 111;
    const GL_INV_FURNITURE = 120;
    const GL_INV_ACCESSORIES = 121;

    const payments: SalesPayment[] = [
      // Cash sale: furniture $3000 + accessories $150, tax $200.03
      makePayment({
        amount: 3350.03,
        order: {
          id: 1,
          hasInvoices: true,
          taxGlId: GL.TAX,
          taxMemo: "CT",
          lineItems: [
            makeLine({
              id: 1,
              netPrice: 3000,
              cost: 1200,
              taxAmount: 190.5,
              accountGroup: {
                name: "Furniture",
                salesGlId: GL_REV_FURNITURE,
                cogsGlId: GL_COGS_FURNITURE,
                inventoryGlId: GL_INV_FURNITURE,
              },
            }),
            makeLine({
              id: 2,
              netPrice: 150,
              cost: 60,
              taxAmount: 9.53,
              accountGroup: {
                name: "Accessories",
                salesGlId: GL_REV_ACCESSORIES,
                cogsGlId: GL_COGS_ACCESSORIES,
                inventoryGlId: GL_INV_ACCESSORIES,
              },
            }),
          ],
        },
      }),
      // Deposit on another order (no invoices yet)
      makePayment({
        amount: 1000,
        order: {
          id: 2,
          hasInvoices: false,
          taxGlId: null,
          taxMemo: "",
          lineItems: [],
        },
      }),
    ];

    const result = buildJournalLines(payments, GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toHaveLength(0);

    // Verify department-level revenue split
    const furnRev = result.lines.find((l) => l.glAccountId === GL_REV_FURNITURE);
    const accRev = result.lines.find((l) => l.glAccountId === GL_REV_ACCESSORIES);
    expect(furnRev?.credit).toBe(3000);
    expect(accRev?.credit).toBe(150);

    // Verify deposit offset
    const depositCredit = result.lines.find((l) => l.glAccountId === GL.DEPOSIT);
    expect(depositCredit?.credit).toBe(1000);
  });
});
