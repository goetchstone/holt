// /app/__tests__/customerLedger.test.ts
//
// Phase 0.5.2 — A-grade unit tests for the pure-helper surface of
// `lib/customerLedger.ts`. Pure helpers (no I/O):
//   - computeRunningBalance
//   - validateAgainstSource
//   - signForType
//
// The DB-touching `appendEntry()` is exercised separately at B grade in
// `__tests__/integration/customerLedger.integration.test.ts` — see the
// header there for why that path needs a real Postgres round-trip.

import {
  LEDGER_TOLERANCE,
  computeRunningBalance,
  signForType,
  validateAgainstSource,
} from "@/lib/customerLedger";

// ─── computeRunningBalance ─────────────────────────────────────────────

describe("computeRunningBalance", () => {
  it("returns balance=0 for an empty list", () => {
    const { balance, perEntry } = computeRunningBalance([]);
    expect(balance).toBe(0);
    expect(perEntry).toEqual([]);
  });

  it("sums a single positive entry", () => {
    const { balance, perEntry } = computeRunningBalance([{ amount: 1000 }]);
    expect(balance).toBe(1000);
    expect(perEntry).toEqual([1000]);
  });

  it("sums a single negative entry (payment)", () => {
    const { balance, perEntry } = computeRunningBalance([{ amount: -250 }]);
    expect(balance).toBe(-250);
    expect(perEntry).toEqual([-250]);
  });

  it("walks a sale -> partial payment -> final payment chain", () => {
    // Customer buys a $1000 sofa, pays $300 deposit on day 1, $700 on
    // delivery. Ending balance is 0.
    const { balance, perEntry } = computeRunningBalance([
      { amount: 1000 }, // SALE
      { amount: -300 }, // PAYMENT (deposit)
      { amount: -700 }, // PAYMENT (final)
    ]);
    expect(balance).toBe(0);
    expect(perEntry).toEqual([1000, 700, 0]);
  });

  it("handles a refund cycle (sale -> payment -> refund)", () => {
    // $500 sale, paid in full, then refunded.
    const { balance, perEntry } = computeRunningBalance([
      { amount: 500 }, // SALE
      { amount: -500 }, // PAYMENT
      { amount: -500 }, // REFUND_ISSUED — refund pays customer back, decreases what they owe
      { amount: 500 }, // ADJUSTMENT_DEBIT — re-instate the sale-side balance from the now-cancelled order
    ]);
    expect(balance).toBe(0);
    expect(perEntry).toEqual([500, 0, -500, 0]);
  });

  it("accepts string amounts (Prisma Decimal serialization)", () => {
    // Prisma returns Decimal columns as strings via json or as
    // Decimal objects via the client; computeRunningBalance accepts
    // either (Number coercion in the helper handles both).
    const { balance } = computeRunningBalance([{ amount: "1000" }, { amount: "-250.50" }]);
    expect(balance).toBe(749.5);
  });

  it("rounds floating-point drift to 2 decimal places per step", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754. round2 normalizes
    // each step so 50 micro-payments don't accumulate drift.
    const entries = Array.from({ length: 100 }, () => ({ amount: 0.1 }));
    const { balance } = computeRunningBalance(entries);
    expect(balance).toBe(10);
  });

  it("returns the per-entry balance trail in order", () => {
    // Used by the daily-recon cron's drift report — 'last entry where
    // ledger and source agreed' is computed from this trail.
    const { perEntry } = computeRunningBalance([
      { amount: 500 },
      { amount: 200 },
      { amount: -300 },
      { amount: 100 },
    ]);
    expect(perEntry).toEqual([500, 700, 400, 500]);
  });
});

// ─── validateAgainstSource ─────────────────────────────────────────────

describe("validateAgainstSource", () => {
  it("returns ok=true when ledger and source agree to the penny", () => {
    const result = validateAgainstSource(1234.56, 1234.56);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(0);
    expect(result.message).toBeUndefined();
  });

  it("returns ok=true within half-penny tolerance", () => {
    // Floating-point drift between two independent sums is normal.
    // LEDGER_TOLERANCE = 0.005 absorbs sub-penny noise.
    const result = validateAgainstSource(1234.561, 1234.56);
    expect(result.ok).toBe(true);
    expect(Math.abs(result.diff)).toBeLessThanOrEqual(LEDGER_TOLERANCE);
  });

  it("returns ok=false when off by a penny", () => {
    const result = validateAgainstSource(100.01, 100.0);
    expect(result.ok).toBe(false);
    expect(result.diff).toBe(0.01);
    expect(result.message).toContain("Ledger out of sync");
    expect(result.message).toContain("100.01");
    expect(result.message).toContain("100.00");
  });

  it("returns ok=false when off by a dollar (large drift)", () => {
    const result = validateAgainstSource(2000, 1999);
    expect(result.ok).toBe(false);
    expect(result.diff).toBe(1);
    expect(result.message).toContain("diff=1.00");
  });

  it("returns ok=false in either direction (negative diff)", () => {
    const result = validateAgainstSource(99, 100);
    expect(result.ok).toBe(false);
    expect(result.diff).toBe(-1);
    expect(result.message).toContain("diff=-1.00");
  });

  it("never throws even on absurd inputs", () => {
    // Defensive — the cron that calls this must never crash on a
    // single bad customer; it should record the drift and continue.
    expect(() => validateAgainstSource(0, 0)).not.toThrow();
    expect(() => validateAgainstSource(-1000000, 1000000)).not.toThrow();
    const result = validateAgainstSource(-1e10, 1e10);
    expect(result.ok).toBe(false);
  });

  it("exposes LEDGER_TOLERANCE as a stable constant (regression guard)", () => {
    // Prevents an accidental "loosen the tolerance" PR from sneaking
    // through code review — the constant moves only in deliberate
    // accounting-policy changes.
    expect(LEDGER_TOLERANCE).toBe(0.005);
  });
});

// ─── signForType ───────────────────────────────────────────────────────

describe("signForType", () => {
  it("returns +1 for balance-increasing types", () => {
    expect(signForType("SALE")).toBe(1);
    expect(signForType("DEPOSIT_RECEIVED")).toBe(1);
    expect(signForType("ADJUSTMENT_DEBIT")).toBe(1);
    // REFUND_ISSUED INCREASES balance: a refund reverses a prior
    // payment, so the customer's balance owed climbs back to whatever
    // the underlying sale still requires. Mirrors
    // paymentService.computeBalance's refund handling (refund subtracts
    // from totalPaid → adds to balanceDue). Bug fixed 2026-05-07 in
    // Phase 0.5.3 — initial commit had REFUND_ISSUED returning -1
    // because I conflated "money out the door" with "balance going
    // down for the customer." It's the opposite.
    expect(signForType("REFUND_ISSUED")).toBe(1);
  });

  it("returns -1 for balance-decreasing types", () => {
    expect(signForType("PAYMENT")).toBe(-1);
    expect(signForType("DEPOSIT_APPLIED")).toBe(-1);
    expect(signForType("ADJUSTMENT_CREDIT")).toBe(-1);
  });

  it("covers every CustomerLedgerEntryType (exhaustiveness guard)", () => {
    // If a new type is added to the enum but signForType isn't updated,
    // TypeScript's switch-exhaustiveness check fails at compile time —
    // but only if the call is typed. Belt-and-suspenders: this test
    // calls each known type to guarantee runtime coverage.
    const allTypes: Parameters<typeof signForType>[0][] = [
      "SALE",
      "PAYMENT",
      "REFUND_ISSUED",
      "DEPOSIT_RECEIVED",
      "DEPOSIT_APPLIED",
      "ADJUSTMENT_DEBIT",
      "ADJUSTMENT_CREDIT",
    ];
    for (const t of allTypes) {
      const sign = signForType(t);
      expect([1, -1]).toContain(sign);
    }
  });
});
