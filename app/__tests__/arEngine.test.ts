// /app/__tests__/arEngine.test.ts
//
// Exhaustive tests for the pure AR core (lib/arEngine.ts). This is money math, so
// every edge is enumerated: deposits, partial payments, partial deliveries,
// disputes (credit memos), over-application guards, on-account remainder, aging,
// and Decimal precision (no float drift). Vertical-agnostic by construction.

import { Prisma } from "@prisma/client";
import {
  invoiceOpenBalance,
  paymentUnapplied,
  isValidApplication,
  allocate,
  customerPosition,
  agingBuckets,
  reconcileCustomerAr,
} from "@/lib/arEngine";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
// Compare at cent precision (value equality, ignores trailing zeros).
const cents = (a: Prisma.Decimal) => a.toFixed(2);

describe("invoiceOpenBalance", () => {
  it("is total minus applied minus credited", () => {
    expect(cents(invoiceOpenBalance(D("100"), D("30")))).toBe("70.00");
    expect(cents(invoiceOpenBalance(D("100"), D("30"), D("20")))).toBe("50.00");
    expect(cents(invoiceOpenBalance(D("100"), D("100")))).toBe("0.00");
  });

  it("is exact on classic float-trap values", () => {
    // 0.1 + 0.2 must be exactly 0.30 -> open 0.00, not 0.0000000001
    expect(cents(invoiceOpenBalance(D("0.30"), D("0.10").plus(D("0.20"))))).toBe("0.00");
  });
});

describe("paymentUnapplied (on-account credit)", () => {
  it("is amount minus applied", () => {
    expect(cents(paymentUnapplied(D("100"), D("60")))).toBe("40.00");
    expect(cents(paymentUnapplied(D("100"), D("100")))).toBe("0.00");
  });
});

describe("isValidApplication", () => {
  it("accepts a positive amount up to the open balance", () => {
    expect(isValidApplication(D("50"), D("70"))).toBe(true);
    expect(isValidApplication(D("70"), D("70"))).toBe(true);
  });
  it("rejects over-application, zero, and negative", () => {
    expect(isValidApplication(D("80"), D("70"))).toBe(false);
    expect(isValidApplication(D("0"), D("70"))).toBe(false);
    expect(isValidApplication(D("-5"), D("70"))).toBe(false);
  });
});

describe("allocate (partial payment across invoices, oldest-first)", () => {
  it("fills invoices in order, no over-application, leftover is remainder", () => {
    const r = allocate(D("150"), [
      { id: 1, open: D("40") },
      { id: 2, open: D("80") },
    ]);
    expect(
      r.applications.map((a) => ({ invoiceId: a.invoiceId, amount: cents(a.amount) })),
    ).toEqual([
      { invoiceId: 1, amount: "40.00" },
      { invoiceId: 2, amount: "80.00" },
    ]);
    expect(cents(r.remainder)).toBe("30.00"); // -> on-account
  });

  it("exact-fills with zero remainder", () => {
    const r = allocate(D("120"), [
      { id: 1, open: D("40") },
      { id: 2, open: D("80") },
    ]);
    expect(cents(r.remainder)).toBe("0.00");
    expect(r.applications).toHaveLength(2);
  });

  it("skips already-paid invoices", () => {
    const r = allocate(D("50"), [
      { id: 1, open: D("0") },
      { id: 2, open: D("80") },
    ]);
    expect(
      r.applications.map((a) => ({ invoiceId: a.invoiceId, amount: cents(a.amount) })),
    ).toEqual([{ invoiceId: 2, amount: "50.00" }]);
    expect(cents(r.remainder)).toBe("0.00");
  });

  it("splits odd cents exactly (no float drift)", () => {
    const r = allocate(D("100.00"), [
      { id: 1, open: D("33.34") },
      { id: 2, open: D("33.33") },
      { id: 3, open: D("33.33") },
    ]);
    const total = r.applications.reduce((a, x) => a.plus(x.amount), D(0));
    expect(cents(total)).toBe("100.00");
    expect(cents(r.remainder)).toBe("0.00");
  });
});

describe("customerPosition — the four real-world flows", () => {
  it("1) 50% deposit on an undelivered order is a liability, not AR", () => {
    const p = customerPosition({
      invoiceOpenBalances: [],
      onAccountCredits: [],
      unearnedDeposits: [D("500")],
    });
    expect(cents(p.ar)).toBe("0.00");
    expect(cents(p.unearnedDeposits)).toBe("500.00");
    expect(cents(p.netOwed)).toBe("-500.00"); // customer is in credit (prepaid)
  });

  it("2) partial delivery: invoice the delivered half, apply half the deposit", () => {
    // $1000 order, $500 deposit. Deliver half -> $500 invoice, $250 deposit
    // applied -> invoice open $250; $250 deposit still held for the undelivered half.
    const p = customerPosition({
      invoiceOpenBalances: [D("250")],
      onAccountCredits: [],
      unearnedDeposits: [D("250")],
    });
    expect(cents(p.ar)).toBe("250.00");
    expect(cents(p.unearnedDeposits)).toBe("250.00");
    expect(cents(p.netOwed)).toBe("0.00"); // square right now; owes more as the rest delivers
  });

  it("3) partial payment leaves an open balance + on-account remainder", () => {
    const p = customerPosition({
      invoiceOpenBalances: [D("250")],
      onAccountCredits: [D("40")],
      unearnedDeposits: [],
    });
    expect(cents(p.ar)).toBe("250.00");
    expect(cents(p.onAccountCredit)).toBe("40.00");
    expect(cents(p.netOwed)).toBe("210.00");
  });

  it("4) dispute: credit memo on one line, customer pays the rest", () => {
    // $1000 invoice (lines 400/400/200); $200 line disputed -> credit memo $200.
    const openAfterCredit = invoiceOpenBalance(D("1000"), D("0"), D("200"));
    expect(cents(openAfterCredit)).toBe("800.00");
    // customer pays the undisputed $800
    const openAfterPay = invoiceOpenBalance(D("1000"), D("800"), D("200"));
    expect(cents(openAfterPay)).toBe("0.00");
  });

  it("holds the reconciliation invariant: netOwed = AR - onAccount - deposits", () => {
    const p = customerPosition({
      invoiceOpenBalances: [D("300"), D("125.50")],
      onAccountCredits: [D("50")],
      unearnedDeposits: [D("75.50")],
    });
    const expected = D("300").plus(D("125.50")).minus(D("50")).minus(D("75.50"));
    expect(cents(p.netOwed)).toBe(cents(expected)); // 300.00
  });
});

describe("agingBuckets", () => {
  const asOf = new Date("2026-06-04T00:00:00Z");
  const due = (daysAgo: number) => new Date(asOf.getTime() - daysAgo * 86_400_000);

  it("buckets open invoices by days past due", () => {
    const b = agingBuckets(
      [
        { open: D("100"), dueDate: due(-5) }, // not due yet -> current
        { open: D("200"), dueDate: due(10) }, // 1-30
        { open: D("300"), dueDate: due(45) }, // 31-60
        { open: D("400"), dueDate: due(75) }, // 61-90
        { open: D("500"), dueDate: due(120) }, // 90+
        { open: D("0"), dueDate: due(200) }, // paid -> ignored
      ],
      asOf,
    );
    expect(cents(b.current)).toBe("100.00");
    expect(cents(b.d1_30)).toBe("200.00");
    expect(cents(b.d31_60)).toBe("300.00");
    expect(cents(b.d61_90)).toBe("400.00");
    expect(cents(b.d90plus)).toBe("500.00");
  });
});

describe("reconcileCustomerAr (the tie-out guarantee)", () => {
  it("passes a clean, fully-applied picture", () => {
    const r = reconcileCustomerAr({
      invoices: [{ id: 1, total: D("100"), applied: D("100") }],
      payments: [{ id: 1, amount: D("100"), applied: D("100") }],
      deposits: [],
    });
    expect(r.ok).toBe(true);
    expect(r.discrepancies).toEqual([]);
    expect(cents(r.position.netOwed)).toBe("0.00");
  });

  it("flags an over-applied invoice", () => {
    const r = reconcileCustomerAr({
      invoices: [{ id: 7, total: D("100"), applied: D("120") }],
      payments: [],
      deposits: [],
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancies.map((d) => d.kind)).toContain("INVOICE_OVERAPPLIED");
    expect(r.discrepancies[0].ref).toBe("invoice:7");
  });

  it("flags an over-applied payment", () => {
    const r = reconcileCustomerAr({
      invoices: [],
      payments: [{ id: 9, amount: D("100"), applied: D("120") }],
      deposits: [],
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancies.map((d) => d.kind)).toContain("PAYMENT_OVERAPPLIED");
  });

  it("flags negative amounts", () => {
    const r = reconcileCustomerAr({
      invoices: [{ id: 1, total: D("-5"), applied: D("0") }],
      payments: [],
      deposits: [],
    });
    expect(r.ok).toBe(false);
    expect(r.discrepancies.map((d) => d.kind)).toContain("NEGATIVE_AMOUNT");
  });

  it("computes the position for a deposit + open invoice", () => {
    const r = reconcileCustomerAr({
      invoices: [{ id: 1, total: D("500"), applied: D("0"), credited: D("0") }],
      payments: [],
      deposits: [{ amount: D("250") }],
    });
    expect(r.ok).toBe(true);
    expect(cents(r.position.ar)).toBe("500.00");
    expect(cents(r.position.unearnedDeposits)).toBe("250.00");
    expect(cents(r.position.netOwed)).toBe("250.00");
  });
});
