// /app/src/lib/arEngine.ts
//
// Pure AR math -- the rock-solid core of the open-item / deposit model. NO I/O,
// no Prisma queries: it operates on plain typed inputs so it works for ANY
// business (services, retail, B2B, projects) and is exhaustively unit-testable.
// All money is Prisma.Decimal; never float. The DB/API layers (PaymentApplication,
// CustomerDeposit, invoices) plug into these functions. See
// docs/domains/accounts-receivable.md.

import { Prisma } from "@prisma/client";

type Money = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value): Money => new Prisma.Decimal(v);
const ZERO = D(0);

function sum(values: Money[]): Money {
  return values.reduce<Money>((acc, v) => acc.plus(v), ZERO);
}

// --- Invoice open balance --------------------------------------------------
// open = total - (payments/deposits applied to it) - (credit memos against it).
// Can legitimately be 0 (paid) or, defensively, negative if over-applied --
// allocation + isValidApplication prevent over-application upstream.
export function invoiceOpenBalance(total: Money, applied: Money, credited: Money = ZERO): Money {
  return total.minus(applied).minus(credited);
}

// --- Payment unapplied (on-account credit) ---------------------------------
// What's left of a payment after it's been applied to invoices -- sits as an
// on-account credit reducing the customer's net balance.
export function paymentUnapplied(amount: Money, applied: Money): Money {
  return amount.minus(applied);
}

// A single manual application must be positive and cannot exceed the invoice's
// open balance (the dispute case: pay the undisputed lines, never over-pay one).
export function isValidApplication(amount: Money, invoiceOpen: Money): boolean {
  return amount.gt(ZERO) && amount.lte(invoiceOpen);
}

// --- Allocation: spread an amount across open invoices, oldest-first --------
export interface OpenInvoice {
  id: number;
  open: Money;
}
export interface Allocation {
  invoiceId: number;
  amount: Money;
}
export interface AllocationResult {
  applications: Allocation[];
  remainder: Money; // left over -> on-account credit
}

// Distributes `amount` across `invoices` (caller orders them oldest-first) up to
// each invoice's open balance. Never over-applies; leftover is the remainder.
// Pure + deterministic.
export function allocate(amount: Money, invoices: OpenInvoice[]): AllocationResult {
  let left = amount;
  const applications: Allocation[] = [];
  for (const inv of invoices) {
    if (left.lte(ZERO)) break;
    if (inv.open.lte(ZERO)) continue;
    const take = Prisma.Decimal.min(left, inv.open);
    applications.push({ invoiceId: inv.id, amount: take });
    left = left.minus(take);
  }
  return { applications, remainder: left };
}

// --- Customer position -----------------------------------------------------
export interface CustomerPositionInput {
  invoiceOpenBalances: Money[]; // AR on delivered/invoiced goods (GL: A/R)
  onAccountCredits: Money[]; // unapplied payments (overpayment / prepaid, not deposits)
  unearnedDeposits: Money[]; // deposits on UNDELIVERED orders (GL: liability)
}
export interface CustomerPosition {
  ar: Money; // GL Accounts Receivable detail
  unearnedDeposits: Money; // GL Customer Deposits (liability)
  onAccountCredit: Money; // unapplied overpayment
  netOwed: Money; // operational: still owed, net of credits + deposits (can be negative = in credit)
}

export function customerPosition(input: CustomerPositionInput): CustomerPosition {
  const ar = sum(input.invoiceOpenBalances);
  const unearnedDeposits = sum(input.unearnedDeposits);
  const onAccountCredit = sum(input.onAccountCredits);
  const netOwed = ar.minus(onAccountCredit).minus(unearnedDeposits);
  return { ar, unearnedDeposits, onAccountCredit, netOwed };
}

// --- Aging -----------------------------------------------------------------
export interface AgingInvoice {
  open: Money;
  dueDate: Date;
}
export interface AgingBuckets {
  current: Money;
  d1_30: Money;
  d31_60: Money;
  d61_90: Money;
  d90plus: Money;
}

const DAY_MS = 86_400_000;

export function agingBuckets(invoices: AgingInvoice[], asOf: Date): AgingBuckets {
  const b: AgingBuckets = {
    current: ZERO,
    d1_30: ZERO,
    d31_60: ZERO,
    d61_90: ZERO,
    d90plus: ZERO,
  };
  for (const inv of invoices) {
    if (inv.open.lte(ZERO)) continue;
    const days = Math.floor((asOf.getTime() - inv.dueDate.getTime()) / DAY_MS);
    if (days <= 0) b.current = b.current.plus(inv.open);
    else if (days <= 30) b.d1_30 = b.d1_30.plus(inv.open);
    else if (days <= 60) b.d31_60 = b.d31_60.plus(inv.open);
    else if (days <= 90) b.d61_90 = b.d61_90.plus(inv.open);
    else b.d90plus = b.d90plus.plus(inv.open);
  }
  return b;
}

// --- Reconciliation (the "books don't drift" guarantee) --------------------
// Pure tie-out over a customer's full AR picture. The daily recon cron + the
// integration tests call this; ok === false means something is structurally
// wrong (over-applied invoice/payment, negative amount) and must alert. Also
// returns the computed position so callers compare it to the stored balance.
export interface ReconInvoice {
  id: number;
  total: Money;
  applied: Money;
  credited?: Money;
}
export interface ReconPayment {
  id: number;
  amount: Money;
  applied: Money;
}
export interface ReconDeposit {
  amount: Money;
}
export type ReconDiscrepancyKind =
  | "INVOICE_OVERAPPLIED"
  | "PAYMENT_OVERAPPLIED"
  | "NEGATIVE_AMOUNT";
export interface ReconDiscrepancy {
  kind: ReconDiscrepancyKind;
  ref: string;
  detail: string;
}
export interface ReconResult {
  ok: boolean;
  discrepancies: ReconDiscrepancy[];
  position: CustomerPosition;
}

export function reconcileCustomerAr(input: {
  invoices: ReconInvoice[];
  payments: ReconPayment[];
  deposits: ReconDeposit[];
}): ReconResult {
  const discrepancies: ReconDiscrepancy[] = [];

  for (const inv of input.invoices) {
    const credited = inv.credited ?? ZERO;
    if (inv.applied.plus(credited).gt(inv.total)) {
      discrepancies.push({
        kind: "INVOICE_OVERAPPLIED",
        ref: `invoice:${inv.id}`,
        detail: `applied+credited ${inv.applied.plus(credited).toFixed(2)} > total ${inv.total.toFixed(2)}`,
      });
    }
    if (inv.total.lt(ZERO) || inv.applied.lt(ZERO) || credited.lt(ZERO)) {
      discrepancies.push({
        kind: "NEGATIVE_AMOUNT",
        ref: `invoice:${inv.id}`,
        detail: "negative amount",
      });
    }
  }

  for (const p of input.payments) {
    if (p.applied.gt(p.amount)) {
      discrepancies.push({
        kind: "PAYMENT_OVERAPPLIED",
        ref: `payment:${p.id}`,
        detail: `applied ${p.applied.toFixed(2)} > amount ${p.amount.toFixed(2)}`,
      });
    }
    if (p.amount.lt(ZERO) || p.applied.lt(ZERO)) {
      discrepancies.push({
        kind: "NEGATIVE_AMOUNT",
        ref: `payment:${p.id}`,
        detail: "negative amount",
      });
    }
  }

  const position = customerPosition({
    invoiceOpenBalances: input.invoices.map((inv) =>
      invoiceOpenBalance(inv.total, inv.applied, inv.credited ?? ZERO),
    ),
    onAccountCredits: input.payments.map((p) => paymentUnapplied(p.amount, p.applied)),
    unearnedDeposits: input.deposits.map((d) => d.amount),
  });

  return { ok: discrepancies.length === 0, discrepancies, position };
}
