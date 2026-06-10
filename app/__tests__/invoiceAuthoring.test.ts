// /app/__tests__/invoiceAuthoring.test.ts
//
// Pure tests for the invoice composer math + lifecycle guards + journal-line
// builders (lib/billing/invoiceAuthoring.ts). No I/O.

import {
  computeInvoiceTotals,
  formatInvoiceNumber,
  invoiceActionError,
  buildIssuanceJournalLines,
  buildInvoicePaymentJournalLines,
  computeStandaloneInvoiceSource,
  InvoiceValidationError,
} from "@/lib/billing/invoiceAuthoring";

describe("computeInvoiceTotals", () => {
  it("computes line amounts, subtotal, tax, and total", () => {
    const t = computeInvoiceTotals(
      [
        { description: "Consulting", quantity: 10, unitPrice: 150 },
        { description: "Setup fee", quantity: 1, unitPrice: 250.5 },
      ],
      0.0635,
    );
    expect(t.lineAmounts).toEqual([1500, 250.5]);
    expect(t.subtotal).toBe(1750.5);
    expect(t.taxAmount).toBe(111.16); // 1750.50 * 0.0635 = 111.156... -> 111.16
    expect(t.total).toBe(1861.66);
  });

  it("rounds each line to cents before summing (no float drift)", () => {
    const t = computeInvoiceTotals([{ description: "Hourly", quantity: 3, unitPrice: 33.335 }]);
    expect(t.lineAmounts).toEqual([100.01]); // 100.005 -> 100.01, not 100.004999...
    expect(t.total).toBe(100.01);
  });

  it("defaults to zero tax", () => {
    const t = computeInvoiceTotals([{ description: "Audit", quantity: 1, unitPrice: 500 }]);
    expect(t.taxAmount).toBe(0);
    expect(t.total).toBe(500);
  });

  it.each([
    [[], "at least one line"],
    [[{ description: "  ", quantity: 1, unitPrice: 5 }], "needs a description"],
    [[{ description: "x", quantity: 0, unitPrice: 5 }], "quantity must be positive"],
    [[{ description: "x", quantity: -1, unitPrice: 5 }], "quantity must be positive"],
    [[{ description: "x", quantity: 1, unitPrice: -5 }], "cannot be negative"],
    [[{ description: "x", quantity: 1, unitPrice: 0 }], "total must be positive"],
  ])("rejects invalid input (%#)", (lines, message) => {
    expect(() => computeInvoiceTotals(lines as Parameters<typeof computeInvoiceTotals>[0])).toThrow(
      message,
    );
  });

  it("rejects out-of-range tax rates", () => {
    const lines = [{ description: "x", quantity: 1, unitPrice: 100 }];
    expect(() => computeInvoiceTotals(lines, -0.01)).toThrow(InvoiceValidationError);
    expect(() => computeInvoiceTotals(lines, 1)).toThrow(InvoiceValidationError);
  });
});

describe("formatInvoiceNumber", () => {
  it("formats INV-YYMMDD-NNN", () => {
    expect(formatInvoiceNumber(new Date(2026, 5, 10), 7)).toBe("INV-260610-007");
    expect(formatInvoiceNumber(new Date(2026, 11, 1), 123)).toBe("INV-261201-123");
  });
});

describe("invoiceActionError (status guards)", () => {
  it.each([
    ["DRAFT", "edit", null],
    ["DRAFT", "issue", null],
    ["DRAFT", "void", null],
    ["DRAFT", "delete", null],
    ["ISSUED", "edit", "Only DRAFT"],
    ["ISSUED", "issue", "Only DRAFT"],
    ["ISSUED", "record-payment", null],
    ["ISSUED", "void", null],
    ["ISSUED", "email", null],
    ["PAID", "record-payment", "ISSUED"],
    ["PAID", "void", "Only DRAFT or ISSUED"],
    ["PAID", "email", null],
    ["VOID", "edit", "Only DRAFT"],
    ["VOID", "record-payment", "ISSUED"],
    ["DRAFT", "record-payment", "ISSUED"],
  ] as const)("%s + %s -> %s", (status, action, expected) => {
    const result = invoiceActionError(status, action);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain(expected);
    }
  });
});

describe("buildIssuanceJournalLines", () => {
  it("debits AR for the total, credits revenue + tax, balanced", () => {
    const lines = buildIssuanceJournalLines({
      invoiceNo: "INV-260610-001",
      subtotal: 1000,
      taxAmount: 63.5,
      arGlAccountId: 1,
      revenueGlAccountId: 2,
      taxGlAccountId: 3,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ glAccountId: 1, debit: 1063.5, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: 2, debit: 0, credit: 1000 });
    expect(lines[2]).toMatchObject({ glAccountId: 3, debit: 0, credit: 63.5 });
  });

  it("omits the tax line when taxAmount is 0", () => {
    const lines = buildIssuanceJournalLines({
      invoiceNo: "INV-1",
      subtotal: 500,
      taxAmount: 0,
      arGlAccountId: 1,
      revenueGlAccountId: 2,
      taxGlAccountId: null,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].debit).toBe(500);
  });

  it("refuses tax without a tax GL mapping", () => {
    expect(() =>
      buildIssuanceJournalLines({
        invoiceNo: "INV-1",
        subtotal: 500,
        taxAmount: 31.75,
        arGlAccountId: 1,
        revenueGlAccountId: 2,
        taxGlAccountId: null,
      }),
    ).toThrow("Sales Tax GL mapping");
  });
});

describe("buildInvoicePaymentJournalLines", () => {
  it("debits cash, credits AR", () => {
    const lines = buildInvoicePaymentJournalLines({
      invoiceNo: "INV-1",
      amount: 250,
      cashGlAccountId: 9,
      arGlAccountId: 1,
    });
    expect(lines[0]).toMatchObject({ glAccountId: 9, debit: 250, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: 1, debit: 0, credit: 250 });
  });

  it("rejects non-positive amounts", () => {
    expect(() =>
      buildInvoicePaymentJournalLines({
        invoiceNo: "INV-1",
        amount: 0,
        cashGlAccountId: 9,
        arGlAccountId: 1,
      }),
    ).toThrow(InvoiceValidationError);
  });
});

describe("computeStandaloneInvoiceSource (drift-check source side)", () => {
  it("sums ISSUED/PAID open balances and ignores DRAFT/VOID", () => {
    const balance = computeStandaloneInvoiceSource([
      { status: "ISSUED", total: 1000, appliedAmounts: [400] }, // 600 open
      { status: "PAID", total: 500, appliedAmounts: [500] }, // 0
      { status: "DRAFT", total: 999, appliedAmounts: [] }, // ignored
      { status: "VOID", total: 999, appliedAmounts: [] }, // ignored
      { status: "ISSUED", total: 250.25, appliedAmounts: [] }, // 250.25
    ]);
    expect(balance).toBe(850.25);
  });

  it("returns 0 for no invoices", () => {
    expect(computeStandaloneInvoiceSource([])).toBe(0);
  });
});

describe("sales-journal exclusion tripwire", () => {
  // Bug class guarded: a refactor of generateSalesJournal dropping the
  // standalone-invoice-payment skip would credit the deposit GL instead of
  // relieving AR and double-count cash (the invoice flow posts its own
  // AR_PAYMENT journal). Source-text check per CLAUDE.md rule 12 — the
  // behavior itself is exercised in invoiceLifecycle.integration.test.ts.
  it("generateSalesJournal still skips invoice-applied orphan payments", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "journalEntry.ts"),
      "utf8",
    );
    expect(src).toMatch(/salesOrderId === null && payment\.applications\.length > 0/);
  });
});
