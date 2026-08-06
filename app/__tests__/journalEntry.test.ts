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
  classifyReturnDisposition,
  matchReturnForLine,
  resolveReturnBookingPath,
  SalesPayment,
  SalesLineForJournal,
  ReturnForJournal,
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

// ─── Native refunds must not re-recognize the original sale ─────
//
// `paymentService.processRefund` writes the refund row against the ORIGINAL
// SalesOrder (`salesOrderId: original.salesOrderId`) with `originalPaymentId`
// pointing back at the payment being reversed. On the refund's day the JE
// generator therefore saw an order whose line items are the original POSITIVE
// sale lines -- and booked them AGAIN, in the same direction as the sale.
// Revenue was credited twice for one sale, COGS debited twice, inventory
// relieved twice, tax credited twice; the resulting imbalance then disappeared
// into the Over/Short plug.
//
// The discriminator is `reversesPaymentId` (Payment.originalPaymentId), NOT
// `isRefund`: imported POS returns also carry `isRefund`, but they hang off
// their own return-order with NEGATIVE line items that have never been booked.
// Those must keep flowing through the B3 sale-in-reverse path above.

describe("buildJournalLines — a native refund does not re-book the original sale", () => {
  /** The shape processRefund produces: negative cash, original order attached. */
  function nativeRefund(overrides: Partial<SalesPayment> = {}): SalesPayment {
    return {
      amount: -1063.5,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      reversesPaymentId: 7,
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        // The ORIGINAL sale's lines -- positive, already booked on sale day.
        lineItems: [makeLine({ netPrice: 1000, cost: 400, taxAmount: 63.5 })],
      },
      ...overrides,
    };
  }

  it("books only the cash leg — no second revenue credit", () => {
    const result = buildJournalLines([nativeRefund()], GL.OVER_SHORT, GL.DEPOSIT);

    // Cash goes out.
    const cash = result.lines.find((l) => l.glAccountId === GL.CASH);
    expect(cash?.credit).toBe(1063.5);
    expect(cash?.debit).toBe(0);

    // The original sale's legs are NOT re-recognized. Before the fix each of
    // these produced a line: revenue credited a second time for a sale that
    // happened days ago.
    expect(result.lines.find((l) => l.glAccountId === GL.REVENUE)).toBeUndefined();
    expect(result.lines.find((l) => l.glAccountId === GL.COGS)).toBeUndefined();
    expect(result.lines.find((l) => l.glAccountId === GL.INVENTORY)).toBeUndefined();
    expect(result.lines.find((l) => l.glAccountId === GL.TAX)).toBeUndefined();
  });

  it("surfaces the unreversed refund as a plug instead of hiding it in revenue", () => {
    // A native refund carries no line-level reversal (processRefund records an
    // amount, not which lines it unwinds), so the day does not balance on its
    // own. That is now a $1,063.50 plug WITH a warning -- honest -- rather
    // than a $212.70 plug plus a phantom $1,000 of revenue.
    const result = buildJournalLines([nativeRefund()], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.overShort).toBe(-1063.5);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Over/Short plug of $1063.50")]),
    );
  });

  it("still lets a normal payment for the same order recognize it, in either arrival order", () => {
    // The guard must not mark the order processed, or whichever row Prisma
    // happens to return first would decide whether the sale is ever booked.
    const sale = makePayment({ order: { ...makePayment().order!, id: 1 } });

    const refundFirst = buildJournalLines([nativeRefund(), sale], GL.OVER_SHORT, GL.DEPOSIT);
    const saleFirst = buildJournalLines([sale, nativeRefund()], GL.OVER_SHORT, GL.DEPOSIT);

    for (const result of [refundFirst, saleFirst]) {
      // Recognized exactly once, not zero times and not twice.
      expect(result.lines.find((l) => l.glAccountId === GL.REVENUE)?.credit).toBe(1000);
      expect(result.lines.find((l) => l.glAccountId === GL.COGS)?.debit).toBe(400);
      // Sale in, refund out, same amount -- the cash nets to nothing.
      expect(result.lines.find((l) => l.glAccountId === GL.CASH)).toBeUndefined();
    }
  });

  it("leaves an IMPORTED POS return untouched (no originalPaymentId, negative lines)", () => {
    // Regression guard on the fix itself. Keying the guard on `isRefund`
    // instead would have silently stopped booking every imported return's
    // reversal -- the B3 path -- and dumped the whole refund into the plug.
    const importedReturn: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      // Ordorite import sets isRefund but never originalPaymentId.
      order: {
        id: 99,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: -500, cost: -200, taxAmount: -31.75 })],
      },
    };
    const result = buildJournalLines([importedReturn], GL.OVER_SHORT, GL.DEPOSIT);

    // Full sale-in-reverse, balanced, and with no plug at all.
    expect(result.lines.find((l) => l.glAccountId === GL.REVENUE)?.debit).toBe(500);
    expect(result.lines.find((l) => l.glAccountId === GL.TAX)?.debit).toBe(31.75);
    expect(result.lines.find((l) => l.glAccountId === GL.COGS)?.credit).toBe(200);
    expect(result.lines.find((l) => l.glAccountId === GL.INVENTORY)?.debit).toBe(200);
    expect(result.overShort).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("still reverses a deposit refund on an order with no invoice", () => {
    // A refunded deposit has no revenue to unwind -- it relieves the deposit
    // liability. That branch runs before the guard and must keep working.
    const depositRefund = nativeRefund({
      amount: -500,
      order: {
        id: 5,
        hasInvoices: false,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [],
      },
    });
    const result = buildJournalLines([depositRefund], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.lines.find((l) => l.glAccountId === GL.CASH)?.credit).toBe(500);
    expect(result.lines.find((l) => l.glAccountId === GL.DEPOSIT)?.debit).toBe(500);
    expect(result.overShort).toBe(0);
  });
});

// ─── B3 classified returns: restock vs. writeoff branching ──────

function makeReturn(overrides: Partial<ReturnForJournal> = {}): ReturnForJournal {
  return {
    id: 1,
    lineItemId: null,
    productId: null,
    status: "INSPECTED",
    inspectionCondition: null,
    ...overrides,
  };
}

describe("classifyReturnDisposition", () => {
  it("returns null for no Return record", () => {
    expect(classifyReturnDisposition(null)).toBeNull();
    expect(classifyReturnDisposition(undefined)).toBeNull();
  });

  it("terminal RESTOCKED status wins regardless of inspection condition", () => {
    expect(
      classifyReturnDisposition(
        makeReturn({ status: "RESTOCKED", inspectionCondition: "MAJOR_DAMAGE" }),
      ),
    ).toBe("RESTOCK");
  });

  it("terminal WRITTEN_OFF status wins regardless of inspection condition", () => {
    expect(
      classifyReturnDisposition(
        makeReturn({ status: "WRITTEN_OFF", inspectionCondition: "LIKE_NEW" }),
      ),
    ).toBe("WRITEOFF");
  });

  it("LIKE_NEW and MINOR_DAMAGE map to RESTOCK", () => {
    expect(
      classifyReturnDisposition(
        makeReturn({ status: "INSPECTED", inspectionCondition: "LIKE_NEW" }),
      ),
    ).toBe("RESTOCK");
    expect(
      classifyReturnDisposition(
        makeReturn({ status: "INSPECTED", inspectionCondition: "MINOR_DAMAGE" }),
      ),
    ).toBe("RESTOCK");
  });

  it("MAJOR_DAMAGE and UNSALVAGEABLE map to WRITEOFF", () => {
    expect(
      classifyReturnDisposition(
        makeReturn({ status: "INSPECTED", inspectionCondition: "MAJOR_DAMAGE" }),
      ),
    ).toBe("WRITEOFF");
    expect(
      classifyReturnDisposition(
        makeReturn({ status: "INSPECTED", inspectionCondition: "UNSALVAGEABLE" }),
      ),
    ).toBe("WRITEOFF");
  });

  it("returns null when not yet classified (no terminal status, no inspection condition)", () => {
    expect(
      classifyReturnDisposition(makeReturn({ status: "INITIATED", inspectionCondition: null })),
    ).toBeNull();
    expect(
      classifyReturnDisposition(makeReturn({ status: "RECEIVED", inspectionCondition: null })),
    ).toBeNull();
  });
});

describe("matchReturnForLine", () => {
  it("returns null when there are no Return records", () => {
    expect(matchReturnForLine({ id: 1, productId: 5 }, [])).toBeNull();
    expect(matchReturnForLine({ id: 1, productId: 5 }, undefined)).toBeNull();
  });

  it("prefers an exact lineItemId FK match", () => {
    const exact = makeReturn({ id: 1, lineItemId: 42, productId: 999 });
    const other = makeReturn({ id: 2, lineItemId: null, productId: 5 });
    expect(matchReturnForLine({ id: 42, productId: 5 }, [other, exact])).toBe(exact);
  });

  it("falls back to a unique same-order productId match", () => {
    const match = makeReturn({ id: 1, lineItemId: null, productId: 5 });
    expect(matchReturnForLine({ id: 42, productId: 5 }, [match])).toBe(match);
  });

  it("does NOT use productId match when it is ambiguous (multiple Returns share the product)", () => {
    const a = makeReturn({ id: 1, lineItemId: null, productId: 5 });
    const b = makeReturn({ id: 2, lineItemId: null, productId: 5 });
    expect(matchReturnForLine({ id: 42, productId: 5 }, [a, b])).toBeNull();
  });

  it("falls back to the sole Return on the order when productId doesn't help", () => {
    const sole = makeReturn({ id: 1, lineItemId: null, productId: null });
    expect(matchReturnForLine({ id: 42, productId: null }, [sole])).toBe(sole);
  });

  it("returns null when multiple Returns exist and none disambiguate", () => {
    const a = makeReturn({ id: 1, lineItemId: null, productId: null });
    const b = makeReturn({ id: 2, lineItemId: null, productId: null });
    expect(matchReturnForLine({ id: 42, productId: null }, [a, b])).toBeNull();
  });
});

describe("resolveReturnBookingPath", () => {
  it("returns UNCLASSIFIED_DEFAULT_RESTOCK when there is no Return record (the imported-POS-return case)", () => {
    expect(resolveReturnBookingPath({ id: 1, productId: 5 }, [])).toBe(
      "UNCLASSIFIED_DEFAULT_RESTOCK",
    );
    expect(resolveReturnBookingPath({ id: 1, productId: 5 }, undefined)).toBe(
      "UNCLASSIFIED_DEFAULT_RESTOCK",
    );
  });

  it("returns UNCLASSIFIED_DEFAULT_RESTOCK when a Return exists but isn't classified yet", () => {
    const ret = makeReturn({ id: 1, productId: 5, status: "RECEIVED", inspectionCondition: null });
    expect(resolveReturnBookingPath({ id: 1, productId: 5 }, [ret])).toBe(
      "UNCLASSIFIED_DEFAULT_RESTOCK",
    );
  });

  it("returns CLASSIFIED_RESTOCK for a matched Return classified as restock", () => {
    const ret = makeReturn({ id: 1, productId: 5, status: "RESTOCKED" });
    expect(resolveReturnBookingPath({ id: 1, productId: 5 }, [ret])).toBe("CLASSIFIED_RESTOCK");
  });

  it("returns CLASSIFIED_WRITEOFF for a matched Return classified as writeoff", () => {
    const ret = makeReturn({ id: 1, productId: 5, status: "WRITTEN_OFF" });
    expect(resolveReturnBookingPath({ id: 1, productId: 5 }, [ret])).toBe("CLASSIFIED_WRITEOFF");
  });
});

describe("buildJournalLines — B3 classified return branching (restock vs. writeoff)", () => {
  const GL_SHRINKAGE = 40;

  it("CLASSIFIED_RESTOCK books identically to the unclassified default (inventory debit, no writeoff line)", () => {
    const ret = makeReturn({ id: 1, productId: 77, status: "RESTOCKED" });
    const payment: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 5,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [
          makeLine({
            netPrice: -500,
            cost: -200,
            taxAmount: -31.75,
            productId: 77,
            accountGroup: {
              name: "Furniture",
              salesGlId: GL.REVENUE,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
              shrinkageGlId: GL_SHRINKAGE,
            },
          }),
        ],
        returns: [ret],
      },
    };

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toEqual([]);

    const invLine = result.lines.find((l) => l.glAccountId === GL.INVENTORY);
    expect(invLine?.debit).toBe(200);
    expect(invLine?.credit).toBe(0);
    expect(result.lines.find((l) => l.glAccountId === GL_SHRINKAGE)).toBeUndefined();
  });

  it("CLASSIFIED_WRITEOFF debits the shrinkage GL instead of Inventory", () => {
    const ret = makeReturn({ id: 1, productId: 77, status: "WRITTEN_OFF" });
    const payment: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 5,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [
          makeLine({
            netPrice: -500,
            cost: -200,
            taxAmount: -31.75,
            productId: 77,
            accountGroup: {
              name: "Furniture",
              salesGlId: GL.REVENUE,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
              shrinkageGlId: GL_SHRINKAGE,
            },
          }),
        ],
        returns: [ret],
      },
    };

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toEqual([]);

    // No inventory movement — the item never re-enters sellable stock.
    expect(result.lines.find((l) => l.glAccountId === GL.INVENTORY)).toBeUndefined();

    // Shrinkage/write-off GL debited for the same magnitude Inventory would
    // have received on a restock.
    const writeoffLine = result.lines.find((l) => l.glAccountId === GL_SHRINKAGE);
    expect(writeoffLine?.debit).toBe(200);
    expect(writeoffLine?.credit).toBe(0);
    expect(writeoffLine?.memo).toBe("Furniture Write-off");

    // COGS still reverses (credit) exactly as it would for a restock — only
    // the inventory-vs-writeoff routing differs.
    const cogsLine = result.lines.find((l) => l.glAccountId === GL.COGS);
    expect(cogsLine?.debit).toBe(0);
    expect(cogsLine?.credit).toBe(200);

    // Sales / Tax / Cash reversal is unaffected by the restock/writeoff branch.
    expect(result.lines.find((l) => l.glAccountId === GL.REVENUE)?.debit).toBe(500);
    expect(result.lines.find((l) => l.glAccountId === GL.TAX)?.debit).toBe(31.75);
    expect(result.lines.find((l) => l.glAccountId === GL.CASH)?.credit).toBe(531.75);
  });

  it("UNCLASSIFIED_DEFAULT_RESTOCK: no Return record at all (the imported-POS-return shape) still restocks inventory", () => {
    const payment: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 5,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [
          makeLine({
            netPrice: -500,
            cost: -200,
            taxAmount: -31.75,
            productId: 77,
            accountGroup: {
              name: "Furniture",
              salesGlId: GL.REVENUE,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
              shrinkageGlId: GL_SHRINKAGE,
            },
          }),
        ],
        // No `returns` array at all — mirrors every historical imported
        // return (the Return table is never populated by import).
      },
    };

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toEqual([]);
    const invLine = result.lines.find((l) => l.glAccountId === GL.INVENTORY);
    expect(invLine?.debit).toBe(200);
    expect(result.lines.find((l) => l.glAccountId === GL_SHRINKAGE)).toBeUndefined();
  });

  it("falls back to restock with a warning when CLASSIFIED_WRITEOFF but no shrinkage GL is configured", () => {
    const ret = makeReturn({ id: 1, productId: 77, status: "WRITTEN_OFF" });
    const payment: SalesPayment = {
      amount: -531.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 5,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [
          makeLine({
            netPrice: -500,
            cost: -200,
            taxAmount: -31.75,
            productId: 77,
            accountGroup: {
              name: "Furniture",
              salesGlId: GL.REVENUE,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
              // shrinkageGlId intentionally omitted
            },
          }),
        ],
        returns: [ret],
      },
    };

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("classified WRITTEN_OFF"),
        expect.stringContaining("no shrinkage/write-off GL configured"),
      ]),
    );
    // Fell back to the restock booking.
    const invLine = result.lines.find((l) => l.glAccountId === GL.INVENTORY);
    expect(invLine?.debit).toBe(200);
  });

  it("multiple return lines on one order route independently by product match", () => {
    // Two different products returned on the same order: one classified
    // writeoff, one with no matching Return (default restock).
    const writtenOff = makeReturn({ id: 1, productId: 77, status: "WRITTEN_OFF" });
    const payment: SalesPayment = {
      amount: -631.75,
      memo: "Cash",
      glAccountId: GL.CASH,
      glCode: "1-1006",
      order: {
        id: 5,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [
          makeLine({
            id: 1,
            netPrice: -500,
            cost: -200,
            taxAmount: -31.75,
            productId: 77,
            accountGroup: {
              name: "Furniture",
              salesGlId: GL.REVENUE,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
              shrinkageGlId: GL_SHRINKAGE,
            },
          }),
          makeLine({
            id: 2,
            netPrice: -100,
            cost: -40,
            taxAmount: -6.35,
            productId: 88, // no Return references product 88
            accountGroup: {
              name: "Furniture",
              salesGlId: GL.REVENUE,
              cogsGlId: GL.COGS,
              inventoryGlId: GL.INVENTORY,
              shrinkageGlId: GL_SHRINKAGE,
            },
          }),
        ],
        returns: [writtenOff],
      },
    };

    const result = buildJournalLines([payment], GL.OVER_SHORT, GL.DEPOSIT);

    expect(result.totalDebits).toBe(result.totalCredits);

    // Inventory: only the $40-cost unclassified line restocks.
    const invLine = result.lines.find((l) => l.glAccountId === GL.INVENTORY);
    expect(invLine?.debit).toBe(40);

    // Shrinkage: only the $200-cost written-off line.
    const writeoffLine = result.lines.find((l) => l.glAccountId === GL_SHRINKAGE);
    expect(writeoffLine?.debit).toBe(200);
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

  // ─── The plug is never silent ─────────────────────────────────
  //
  // The perversity this closes: configuring an Over/Short account used to
  // make the generator QUIETER. Without one you got a warning; with one, the
  // difference was absorbed and the journal reported balanced, with nothing
  // pushed to `warnings` at all. `assertBalanced` cannot catch it either --
  // after the plug the entry genuinely balances.

  /** A day whose payment is `short` dollars under revenue + tax. */
  function shortDay(short: number): SalesPayment {
    return makePayment({
      amount: round2(1063.5 - short),
      order: {
        id: 1,
        hasInvoices: true,
        taxGlId: GL.TAX,
        taxMemo: "CT",
        lineItems: [makeLine({ netPrice: 1000, taxAmount: 63.5, cost: 400 })],
      },
    });
  }

  it("warns EVERY time the plug fires, naming the amount and the journal", () => {
    const result = buildJournalLines([shortDay(0.5)], GL.OVER_SHORT, GL.DEPOSIT, "SJ20260501");

    // Still balances -- that was never the problem.
    expect(result.totalDebits).toBe(result.totalCredits);
    // ...but it no longer does so silently.
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Over/Short plug of $0.50")]),
    );
    expect(result.warnings[0]).toContain("SJ20260501");
  });

  it("reports the absorbed imbalance as BuildResult.overShort", () => {
    // The only evidence left that the entry did not balance on its own,
    // signed the same way the builder computes it (debits - credits).
    const short = buildJournalLines([shortDay(0.5)], GL.OVER_SHORT, GL.DEPOSIT);
    expect(short.overShort).toBe(-0.5);

    const over = buildJournalLines([shortDay(-0.5)], GL.OVER_SHORT, GL.DEPOSIT);
    expect(over.overShort).toBe(0.5);
  });

  it("reports overShort as 0 when the journal balanced on its own", () => {
    const result = buildJournalLines([makePayment()], GL.OVER_SHORT, GL.DEPOSIT);
    expect(result.overShort).toBe(0);
    expect(result.lines.find((l) => l.glAccountId === GL.OVER_SHORT)).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("grades a $0.02 rounding plug as noise and a $12,000 plug as a missing payment", () => {
    const rounding = buildJournalLines([shortDay(0.02)], GL.OVER_SHORT, GL.DEPOSIT);
    expect(rounding.warnings[0]).toContain("Over/Short plug of $0.02");
    expect(rounding.warnings[0]).toContain("Within the $1.00 rounding threshold");
    expect(rounding.warnings[0]).not.toContain("Do not export");

    const material = buildJournalLines([shortDay(12000)], GL.OVER_SHORT, GL.DEPOSIT);
    expect(material.warnings[0]).toContain("Over/Short plug of $12000.00");
    expect(material.warnings[0]).toContain("above the $1.00 review threshold");
    expect(material.warnings[0]).toContain("Do not export");
    expect(Math.abs(material.overShort)).toBe(12000);
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
