// /app/src/lib/paymentService.ts
import { getAppSettings, getBusinessTimeZone } from "@/lib/appSettings";
import { businessDayStamp } from "@/lib/reports/businessDay";
import { prisma } from "@/lib/prisma";
import { getVendorPrefixRules } from "@/lib/vendorPrefixService";
import { isVendorNumber, toBarcode, toVendorNumber } from "@/lib/vendorNumbering";
import {
  assertCapability,
  getActiveProvider,
  getProviderForPayment,
  type CheckoutResult,
} from "@/lib/payments";
import { syncServiceAppointments } from "@/lib/serviceDispatchService";
import { appendEntry, signForType } from "@/lib/customerLedger";
import { logError } from "@/lib/logger";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { countedPaymentWhere, isPaymentExcludedFromBalance } from "@/lib/paymentBalance";
import { isCountedLine } from "@/lib/salesOrderRevenue";
import { issueStoreCredit, spendStoreCredit } from "@/lib/customerCredit";
import { refundCounts } from "@/lib/returns/returnMoney";
import type { Payment, Prisma } from "@prisma/client";
import { expectedArrival } from "@/lib/vendorLeadTime";

type Tx = Prisma.TransactionClient;

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// Accept Prisma Decimal, string, or number -- Number() handles all three
type Numeric = number | string | { toNumber(): number };

interface LineItemForBalance {
  netPrice: Numeric;
  orderedQuantity: Numeric;
  vatAmount?: Numeric | null;
  /** Required, not optional: a caller that does not select it would silently
   *  count cancelled and replaced lines (see COUNTED_LINE_STATUSES). */
  lineItemStatus: string;
}

interface PaymentForBalance {
  paymentAmount: Numeric;
  status?: string | null;
  isRefund: boolean;
}

// the POS rounding errors create micro-balances ($0.01, $0.02).
// Balances at or below this threshold are treated as paid in full.
const MICRO_BALANCE_THRESHOLD = 1.0;

// Pure computation -- no database access. Exported for testing.
//
// REWRITE CHAIN NOTE: when a customer balance query spans a rewrite
// chain (base SO-12345 + accounting return SR-12345 + rewrite SO-12345 - A),
// all three orders stay active. Balance math over the chain works because the
// payments import runner SKIPS the phantom "Gift Card" transfer that the POS
// attaches to the rewrite (it represents a credit-note application of the
// base's deposit, not a real second payment). With the phantom skipped, summing
// the chain yields: base_total - card_deposit - return_total + rewrite_total
// = rewrite_total - card_deposit. See docs/domains/POS-import.md
// "Rewrites -- what the payments really mean" and CLAUDE.md Key Gotchas.
//
// PENDING PAYMENTS NOTE (fixed 2026-08-05): PENDING no longer counts toward
// totalPaid -- it used to, on the theory that a PENDING row meant "a checkout
// is genuinely open, don't let a second one start." That protection was real
// but the mechanism was wrong: recordPendingPayment writes the PENDING row
// BEFORE the customer pays, and nothing ever ended the PENDING state if they
// abandoned or declined the checkout (no `checkout.session.expired` handling,
// no sweeper). The result was a balance permanently reading $0 with no path
// in the product to fix it -- direct SQL was the only way to clear the row.
// The double-charge protection this used to serve now lives in
// `findActivePendingPayment`, an explicit pre-checkout check in
// `startHostedCheckout`, and PENDING rows get a real terminal state via the
// webhook's expiration handling plus `sweepStalePendingPayments`. See
// isPaymentExcludedFromBalance in @/lib/paymentBalance, which every other
// balance computation in the app shares with this function so they can't
// drift back apart.
export function computeBalance(
  lineItems: LineItemForBalance[],
  payments: PaymentForBalance[],
): { totalDue: number; totalPaid: number; balanceDue: number } {
  // INVARIANT: OrderLineItem.netPrice stores the LINE TOTAL (unit price × qty),
  // never the unit price. Both the POS imports and POS creation follow this model.
  // Do NOT multiply by orderedQuantity here — that was a bug that inflated totals
  // for multi-qty line items (e.g. a rug pad sold by the square foot). Fixed
  // 2026-04-17.
  // Only lines the customer still owes. A cancelled or replaced line keeps its
  // price on the row; summing every row charged customers for cancelled lines
  // at checkout, on emailed payment links and in portal Pay, and charged a
  // replaced line twice (the original and its replacement).
  const totalDue = round2(
    lineItems.reduce((sum, li) => {
      if (!isCountedLine(li.lineItemStatus)) return sum;
      const lineTotal = Number(li.netPrice);
      const vat = Number(li.vatAmount ?? 0);
      return sum + lineTotal + vat;
    }, 0),
  );

  const totalPaid = round2(
    payments.reduce((sum, p) => {
      if (isPaymentExcludedFromBalance(p.status)) return sum;
      const amt = Number(p.paymentAmount);
      return sum + (p.isRefund ? -Math.abs(amt) : amt);
    }, 0),
  );

  const rawBalance = round2(totalDue - totalPaid);
  // Snap micro-balances to zero — the POS rounding artifacts
  const balanceDue = Math.abs(rawBalance) <= MICRO_BALANCE_THRESHOLD ? 0 : rawBalance;

  return { totalDue, totalPaid, balanceDue };
}

// Pure computation for refundable amount: the original less every refund that
// paid out or may still pay out (see refundCounts -- a FAILED or VOIDED refund
// did not). processRefund's cap, and nothing else's.
export function computeRefundable(originalAmount: number, previousRefundAmounts: number[]): number {
  const totalRefunded = previousRefundAmounts.reduce((sum, a) => sum + Math.abs(a), 0);
  return round2(originalAmount - totalRefunded);
}

interface RecordPaymentInput {
  method: string;
  amount: number;
  registerId?: number;
  tillId?: number;
  staffMemberId?: number;
  customerId?: number;
  processorType?: string;
  processorTxnId?: string;
  processorData?: any;
  cardLast4?: string;
  cardBrand?: string;
  checkNumber?: string;
  giftCardId?: number;
  createdBy?: string;
}

export interface RefundInput {
  amount: number;
  reason?: string;
  registerId?: number;
  tillId?: number;
  staffMemberId?: number;
  createdBy?: string;
  /** The native return this refund pays out (lib/returns/refundReturn.ts). */
  returnId?: number;
  /** The order the refund row books to; a return's own order. Default: the original's. */
  salesOrderId?: number;
  /**
   * Runs inside the reserving transaction, after the payment's lock and the
   * payment's own cap: a caller's further check (a return's refundable cap).
   */
  guard?: (tx: Tx) => Promise<void>;
}

/** A refund refused before any money moved: the caller said something wrong. */
export class RefundError extends Error {}

/**
 * The processor did not confirm the refund. The refund row stays PENDING --
 * counted by the cap, out of balances and the journal -- because an error is
 * not proof that no money moved; a retry reuses the same idempotency key, so
 * it can never refund twice (retryProcessorRefund).
 */
export class RefundProcessorError extends Error {}

interface OrderBalance {
  totalDue: number;
  totalPaid: number;
  balanceDue: number;
  payments: {
    id: number;
    date: Date;
    type: string;
    method: string | null;
    amount: number;
    status: string | null;
    isRefund: boolean;
  }[];
}

export async function calculateOrderBalance(orderId: number): Promise<OrderBalance> {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      lineItems: {
        select: { netPrice: true, orderedQuantity: true, vatAmount: true, lineItemStatus: true },
      },
      payments: {
        select: {
          id: true,
          paymentDate: true,
          paymentType: true,
          method: true,
          paymentAmount: true,
          status: true,
          isRefund: true,
        },
        orderBy: { paymentDate: "asc" },
      },
    },
  });

  const { totalDue, totalPaid, balanceDue } = computeBalance(order.lineItems, order.payments);

  return {
    totalDue,
    totalPaid,
    balanceDue,
    payments: order.payments.map((p) => ({
      id: p.id,
      date: p.paymentDate,
      type: p.paymentType,
      method: p.method,
      amount: Number(p.paymentAmount),
      status: p.status,
      isRefund: p.isRefund,
    })),
  };
}

export async function recordPayment(orderId: number, input: RecordPaymentInput): Promise<Payment> {
  return prisma.$transaction((tx) => recordPaymentTx(tx, orderId, input));
}

/** recordPayment inside the caller's transaction. */
export async function recordPaymentTx(
  tx: Tx,
  orderId: number,
  input: RecordPaymentInput,
): Promise<Payment> {
  const rounded = round2(input.amount);
  if (rounded <= 0) {
    throw new Error("Payment amount must be positive");
  }

  // Hydrate orderno alongside the existence check — saves a round trip
  // for the ledger reference field below.
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, orderno: true, customerId: true },
  });

  if (input.tillId) {
    const till = await tx.till.findUniqueOrThrow({ where: { id: input.tillId } });
    if (till.status !== "OPEN") {
      throw new Error(`Till ${input.tillId} is not open (status: ${till.status})`);
    }
  }

  const paymentType = METHOD_DISPLAY[input.method] ?? input.method;

  if (input.method === "GIFT_CARD") {
    if (!input.giftCardId) {
      throw new Error("giftCardId is required for gift card payments");
    }
    const card = await tx.giftCard.findUniqueOrThrow({
      where: { id: input.giftCardId },
    });
    const balance = Number(card.currentBalance);
    if (balance < rounded) {
      throw new Error(
        `Insufficient gift card balance: available $${balance.toFixed(2)}, requested $${rounded.toFixed(2)}`,
      );
    }
    const balanceBefore = balance;
    const balanceAfter = round2(balanceBefore - rounded);

    await tx.giftCardTransaction.create({
      data: {
        giftCardId: input.giftCardId,
        transactionType: "REDEMPTION",
        amount: -rounded,
        balanceBefore,
        balanceAfter,
        createdBy: input.createdBy,
      },
    });
    await tx.giftCard.update({
      where: { id: input.giftCardId },
      data: { currentBalance: balanceAfter },
    });
  }

  // Store credit is the order's own customer's (spendStoreCredit refuses
  // anyone else's), so the customer defaults to the order's.
  const creditCustomerId =
    input.method === "STORE_CREDIT" ? (input.customerId ?? order.customerId ?? null) : null;
  if (input.method === "STORE_CREDIT" && creditCustomerId == null) {
    throw new Error(
      "Store credit can only be spent on an order with a customer: add the customer to the order first.",
    );
  }

  const payment = await tx.payment.create({
    data: {
      salesOrderId: orderId,
      paymentDate: new Date(),
      paymentType,
      paymentAmount: rounded,
      status: "COMPLETED",
      method: input.method as any,
      registerId: input.registerId,
      tillId: input.tillId,
      staffMemberId: input.staffMemberId,
      customerId: creditCustomerId ?? input.customerId,
      processorType: input.processorType,
      processorTxnId: input.processorTxnId,
      processorData: input.processorData ?? undefined,
      cardLast4: input.cardLast4,
      cardBrand: input.cardBrand,
      checkNumber: input.checkNumber,
      giftCardId: input.giftCardId,
      createdBy: input.createdBy,
    },
  });

  // After the row exists, so the credit's USAGE row points at the payment
  // that spent it.
  if (creditCustomerId != null) {
    await spendStoreCredit(tx, {
      customerId: creditCustomerId,
      amount: rounded,
      paymentId: payment.id,
      salesOrderId: orderId,
      createdBy: input.createdBy,
    });
  }

  // Phase 0.5.4 (2026-05-12) — append the AR-ledger entry inside the
  // SAME transaction so Customer.openArBalance and the Payment row
  // commit atomically. Extracted to keep recordPayment under the cog-
  // complexity gate; the helper handles customerId resolution + the
  // appendEntry call + error surfacing.
  await appendPaymentLedger(tx, {
    customerId: input.customerId ?? order.customerId ?? null,
    type: "PAYMENT",
    amount: -rounded,
    salesOrderId: orderId,
    paymentId: payment.id,
    reference: order.orderno || `order-${orderId}`,
    createdBy: input.createdBy,
  });

  return payment;
}

/**
 * Phase 0.5.4 — single point that calls `appendEntry` from the payment
 * flow. Skips when there's no customer to ledger against (true walk-in
 * cash sales on unlinked orders). Surfaces any underlying ledger error
 * with structured logging before rethrowing so the caller's transaction
 * rolls back atomically — silent skip would re-introduce the drift this
 * wiring was added to prevent.
 */
async function appendPaymentLedger(
  tx: Tx,
  input: {
    customerId: number | null;
    type: "PAYMENT" | "REFUND_ISSUED";
    amount: number;
    salesOrderId: number | undefined;
    paymentId: number;
    reference: string;
    notes?: string;
    createdBy?: string | null;
  },
): Promise<void> {
  if (input.customerId === null) return; // walk-in; nothing to ledger
  try {
    await appendEntry(
      {
        customerId: input.customerId,
        type: input.type,
        amount: input.amount,
        salesOrderId: input.salesOrderId,
        paymentId: input.paymentId,
        reference: input.reference,
        notes: input.notes,
        createdBy: input.createdBy ?? undefined,
      },
      tx,
    );
  } catch (err) {
    logError(`appendEntry failed during ${input.type}`, err);
    throw err;
  }
}

/** What a hosted checkout pays: a sales order's balance, or an authored
 *  invoice's. The PENDING row is bound to it structurally (salesOrderId or
 *  invoiceId), and the webhook routes on that binding, never on metadata. */
export type CheckoutTarget = { orderId: number } | { invoiceId: number };

function targetWhere(target: CheckoutTarget): { salesOrderId: number } | { invoiceId: number } {
  return "orderId" in target ? { salesOrderId: target.orderId } : { invoiceId: target.invoiceId };
}

/**
 * Create a PENDING payment with NO ledger entry. For processor flows (Stripe
 * checkout) where the money isn't confirmed until a webhook fires — the AR-ledger
 * entry is posted later by completePayment(), so an abandoned checkout never
 * leaves a phantom payment in the books. (#137)
 */
export async function recordPendingPayment(
  target: CheckoutTarget,
  input: {
    method: string;
    amount: number;
    processorType?: string;
    processorTxnId?: string;
    customerId?: number | null;
    createdBy?: string | null;
  },
): Promise<Payment> {
  const rounded = round2(input.amount);
  if (rounded <= 0) {
    throw new Error("Payment amount must be positive");
  }
  const owner =
    "orderId" in target
      ? await prisma.salesOrder.findUniqueOrThrow({
          where: { id: target.orderId },
          select: { customerId: true },
        })
      : await prisma.invoice.findUniqueOrThrow({
          where: { id: target.invoiceId },
          select: { customerId: true },
        });
  return prisma.payment.create({
    data: {
      ...targetWhere(target),
      paymentDate: new Date(),
      paymentType: (METHOD_DISPLAY as Record<string, string>)[input.method] ?? input.method,
      paymentAmount: rounded,
      status: "PENDING",
      method: input.method as any,
      processorType: input.processorType,
      processorTxnId: input.processorTxnId,
      customerId: input.customerId ?? owner.customerId,
      createdBy: input.createdBy ?? undefined,
    },
  });
}

/**
 * How long a hosted-checkout session stays "genuinely open" before it's
 * abandoned rather than in-flight. Stripe checkout sessions expire after 24h
 * (Stripe's own default and maximum for `expires_at`), so this is the
 * shared cutoff for two independent mechanisms:
 *   - `findActivePendingPayment` treats a PENDING row older than this as
 *     stale, so it stops blocking a new checkout.
 *   - `sweepStalePendingPayments` treats it as abandoned and marks it
 *     FAILED, for rows the webhook's `checkout.session.expired` handling
 *     never caught (missed delivery, or a provider with no expiry event —
 *     see squareProvider.ts).
 */
export const PENDING_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface ActivePendingPayment {
  id: number;
  amount: number;
  createdAt: Date;
  ageMinutes: number;
}

/**
 * Look for a PENDING payment on this order or invoice that's still within the
 * session lifetime — i.e. a checkout that may genuinely still be open. This is the
 * double-charge protection that used to live inside computeBalance (treating
 * PENDING as paid, so a second payment link would show a $0 balance and
 * refuse). Moved here so the check can be evaluated explicitly, once, at the
 * moment a new checkout is about to be created, rather than baked into every
 * balance read in the app.
 *
 * Callers should surface `amount`/`ageMinutes` to the operator ("a $400
 * payment link is already open, started 12 minutes ago") rather than a bare
 * refusal — the whole point is that the operator needs to know THIS,
 * specifically, not just that something went wrong.
 */
export async function findActivePendingPayment(
  target: CheckoutTarget,
): Promise<ActivePendingPayment | null> {
  const cutoff = new Date(Date.now() - PENDING_SESSION_LIFETIME_MS);
  const pending = await prisma.payment.findFirst({
    // A PENDING refund is not an open checkout.
    where: {
      ...targetWhere(target),
      status: "PENDING",
      isRefund: false,
      paymentDate: { gte: cutoff },
    },
    orderBy: { paymentDate: "desc" },
  });
  if (!pending) return null;
  return {
    id: pending.id,
    amount: Number(pending.paymentAmount),
    createdAt: pending.paymentDate,
    ageMinutes: Math.max(0, Math.round((Date.now() - pending.paymentDate.getTime()) / 60_000)),
  };
}

/**
 * Void a PENDING payment deliberately — either an operator clearing a stuck
 * row from the product (see /api/sales/orders/[id]/payments/[paymentId]/void,
 * MANAGER/ADMIN-gated because voiding a payment row is money-adjacent), or
 * a new checkout replacing an open one the customer says never arrived (the
 * `force` path in startHostedCheckout). Only PENDING rows are eligible: a
 * COMPLETED payment must go through `processRefund` instead, which reverses
 * real money and posts the ledger entry this function deliberately does NOT —
 * a PENDING row was never posted to the ledger (see recordPendingPayment), so
 * there's nothing to reverse.
 */
export async function voidPendingPayment(
  paymentId: number,
  opts: { voidedBy?: string | null; reason?: string } = {},
): Promise<Payment> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.status !== "PENDING") {
      throw new Error(
        `Cannot void payment ${paymentId}: status is ${payment.status}, expected PENDING`,
      );
    }
    return tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "VOIDED",
        updatedBy: opts.voidedBy ?? undefined,
        processorData: opts.reason ? { voidReason: opts.reason } : undefined,
      },
    });
  });
}

/**
 * A checkout is already open on this order or invoice. Carries the open one
 * so the caller can name it (amount, age) instead of refusing bare. The
 * message is the staff wording; a customer-facing route words its own from
 * `existing`.
 */
export class CheckoutAlreadyOpenError extends Error {
  constructor(
    readonly existing: ActivePendingPayment,
    target: CheckoutTarget,
  ) {
    super(
      `A payment link for $${existing.amount.toFixed(2)} is already open on this ` +
        `${"orderId" in target ? "order" : "invoice"} (started ${existing.ageMinutes} min ` +
        `ago). If the customer says it never arrived, retry with force:true to void it and ` +
        `send a new one.`,
    );
    this.name = "CheckoutAlreadyOpenError";
  }
}

export interface StartHostedCheckoutInput {
  target: CheckoutTarget;
  /** Major units. The caller's own balance rule decides it. */
  amount: number;
  /** Who started it: a staff email, or "customer-portal" / "client-portal".
   *  Recorded as createdBy on the new row, and updatedBy on one it replaces. */
  actor?: string | null;
  /** Void the checkout already open on this target and start a new one, for
   *  when the customer says the earlier link never arrived. */
  force?: boolean;
  /** The one line-item label the payer sees. */
  description: string;
  customerEmail?: string;
  /** Echoed back on the webhook as a cross-check; never the routing key. */
  metadata: Record<string, string>;
  urls: { successUrl: string; cancelUrl: string };
}

/**
 * The one way to start an online card payment, for an order or an invoice.
 * Refuses while a checkout on the same target may still be open (both could
 * land: a double charge), unless `force` voids that one first. Then opens the
 * session on the active provider and writes the PENDING row through
 * recordPendingPayment: method CARD, so labelled "Card"; customer filled in;
 * processorType recorded, so refunds and webhooks route by the processor that
 * took it, never the one active later.
 *
 * Each caller keeps its own auth, balance rule, response shape and wording;
 * this is only the sequence they used to paste.
 */
export async function startHostedCheckout(
  input: StartHostedCheckoutInput,
): Promise<CheckoutResult> {
  const existing = await findActivePendingPayment(input.target);
  if (existing) {
    if (!input.force) throw new CheckoutAlreadyOpenError(existing, input.target);
    await voidPendingPayment(existing.id, {
      voidedBy: input.actor,
      reason: "Replaced by a new checkout (force)",
    });
  }

  // Whichever processor the deployment has made active takes new payments.
  const provider = getActiveProvider();
  assertCapability(provider, "hostedCheckout");
  const settings = await getAppSettings();

  const checkout = await provider.createCheckout!({
    amount: input.amount,
    currency: settings.currency || "USD",
    description: input.description,
    customerEmail: input.customerEmail,
    metadata: input.metadata,
    successUrl: input.urls.successUrl,
    cancelUrl: input.urls.cancelUrl,
  });

  // PENDING + no ledger entry yet. The AR-ledger entry is posted only when the
  // webhook confirms the charge (completePayment), so an abandoned checkout
  // leaves nothing in the books. (#137)
  await recordPendingPayment(input.target, {
    method: "CARD",
    amount: input.amount,
    processorType: provider.id.toUpperCase(),
    processorTxnId: checkout.providerTxnId,
    createdBy: input.actor,
  });

  return checkout;
}

/**
 * Mark a PENDING payment FAILED because the processor's checkout session (or
 * order, for Square) expired or was abandoned without being paid. Called
 * from two places that both need to end a PENDING row's life without ANY
 * ledger entry — nothing was ever posted for a PENDING row, so there is
 * nothing to reverse:
 *   - the webhook's `checkout.session.expired` branch (immediate — Stripe
 *     fires this the moment the session actually expires)
 *   - `sweepStalePendingPayments` (a backstop — webhooks get missed, and
 *     Square has no expiry event at all)
 *
 * Idempotent by construction: only a currently-PENDING row transitions.
 * Returns null (rather than throwing) when the row isn't PENDING anymore —
 * a real race the sweeper and the webhook can both hit (the customer pays
 * at the exact moment the row goes stale), and "already resolved, leave it
 * alone" is correct, not an error.
 */
export async function expirePendingPayment(paymentId: number): Promise<Payment | null> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== "PENDING") return null;
    return tx.payment.update({ where: { id: paymentId }, data: { status: "FAILED" } });
  });
}

export interface StalePendingSweepResult {
  swept: number;
  totalAmount: number;
  payments: { id: number; salesOrderId: number | null; amount: number; ageHours: number }[];
}

/**
 * Backstop for `expirePendingPayment` — sweeps every PENDING row older than
 * `PENDING_SESSION_LIFETIME_MS` (the webhook's `checkout.session.expired`
 * handling should have already caught most of these; this exists because
 * webhooks get missed, and Square's Payment Links API has no expiry event to
 * miss in the first place — see squareProvider.ts). Called from the
 * `expire-stale-pending-payments` automation, on the same Bearer-token-or-
 * session cron pattern as the other jobs in pages/api/automations/*.
 */
export async function sweepStalePendingPayments(): Promise<StalePendingSweepResult> {
  const cutoff = new Date(Date.now() - PENDING_SESSION_LIFETIME_MS);
  const stale = await prisma.payment.findMany({
    // Never a PENDING refund: it waits on a processor that may have paid it
    // out, and failing it would let the same money be refunded again.
    where: { status: "PENDING", isRefund: false, paymentDate: { lt: cutoff } },
    select: { id: true, salesOrderId: true, paymentAmount: true, paymentDate: true },
  });

  const swept: StalePendingSweepResult["payments"] = [];
  for (const p of stale) {
    const updated = await expirePendingPayment(p.id);
    if (!updated) continue; // raced with a completion between the query and the update — leave it alone
    swept.push({
      id: p.id,
      salesOrderId: p.salesOrderId,
      amount: Number(p.paymentAmount),
      ageHours: Math.round((Date.now() - p.paymentDate.getTime()) / 3_600_000),
    });
  }

  return {
    swept: swept.length,
    totalAmount: round2(swept.reduce((sum, p) => sum + p.amount, 0)),
    payments: swept,
  };
}

/**
 * Mark a PENDING payment COMPLETED and post its AR-ledger entry atomically —
 * called when a processor webhook confirms the charge. Idempotent: a re-fired
 * webhook on an already-COMPLETED payment is a no-op, so the ledger entry is
 * never double-posted. (#137)
 */
export async function completePayment(
  paymentId: number,
  extraData?: {
    processorData?: Record<string, unknown>;
    cardLast4?: string;
    cardBrand?: string;
  },
): Promise<Payment> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.status === "COMPLETED") return payment;

    const order = payment.salesOrderId
      ? await tx.salesOrder.findUnique({
          where: { id: payment.salesOrderId },
          select: { orderno: true, customerId: true },
        })
      : null;

    const updated = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "COMPLETED",
        processorData: (extraData?.processorData as object) ?? undefined,
        cardLast4: extraData?.cardLast4,
        cardBrand: extraData?.cardBrand,
      },
    });

    await appendPaymentLedger(tx, {
      customerId: payment.customerId ?? order?.customerId ?? null,
      type: "PAYMENT",
      amount: -round2(Number(payment.paymentAmount)),
      salesOrderId: payment.salesOrderId ?? undefined,
      paymentId: payment.id,
      reference: order?.orderno || `order-${payment.salesOrderId}`,
      createdBy: payment.createdBy ?? undefined,
    });

    return updated;
  });
}

/** Advisory-lock key space for refunds of one payment; see STOCK_LOCK_SPACE in inventory/ledger.ts. */
const REFUND_LOCK_SPACE = 5_461_070;

/**
 * How long a PENDING processor refund can be retried with its key. Stripe
 * keeps an idempotency key for 24 hours; after that the same key could refund
 * again, so an older PENDING refund is settled by hand from the processor's
 * dashboard (void it if nothing went out) instead of retried.
 */
export const REFUND_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const refundKey = (refundPaymentId: number) => `holt-refund-${refundPaymentId}`;

/**
 * Give money back on a payment, to the way it was paid: a card through the
 * processor that took it, cash or a check from the till, a gift card reloaded,
 * store credit put back on the account. There is no "refund it as something
 * else": a refund to store credit instead of the card is a different
 * transaction (lib/returns/refundReturn.ts), never a card refund that also
 * issues credit.
 *
 * Three steps, so the record and the money cannot disagree:
 *   1. Reserve, in one transaction under the payment's lock: check the cap
 *      and write the refund row. Without a processor that is the whole
 *      refund: the row is COMPLETED with its side effects and ledger entry.
 *      With one, the row is PENDING -- counted by the cap, out of balances.
 *   2. Call the processor OUTSIDE any transaction, with an idempotency key
 *      that is the refund row's id.
 *   3. Settle: PENDING -> COMPLETED with the processor's refund id, ledger
 *      entry and side effects, in one transaction.
 * A crash between 2 and 3 leaves the PENDING row as the record, and
 * retryProcessorRefund finishes it with the same key.
 */
export async function processRefund(paymentId: number, input: RefundInput): Promise<Payment> {
  const rounded = round2(input.amount);
  if (rounded <= 0) {
    throw new RefundError("Refund amount must be positive");
  }

  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_LOCK_SPACE}::int, ${paymentId}::int)`;
    const original = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refundedPayments: { select: { paymentAmount: true, status: true } } },
    });
    if (original.isRefund) throw new RefundError("A refund cannot itself be refunded.");
    if (original.status !== "COMPLETED") {
      throw new RefundError(
        `Cannot refund payment ${paymentId}: status is ${original.status}, expected COMPLETED`,
      );
    }
    const refundable = computeRefundable(
      Number(original.paymentAmount),
      original.refundedPayments
        .filter((r) => refundCounts(r.status))
        .map((r) => Number(r.paymentAmount)),
    );
    if (rounded > refundable) {
      throw new RefundError(
        `Refund amount $${rounded.toFixed(2)} exceeds refundable balance $${refundable.toFixed(2)}`,
      );
    }
    await input.guard?.(tx);

    // Route by the ORIGINAL payment's processor -- never the currently-active
    // one (rule 60). After an org switches providers, previously captured
    // payments must still refund through whoever actually took the money.
    const viaProcessor = !!(original.processorType && original.processorTxnId);
    const row = await tx.payment.create({
      data: {
        salesOrderId: input.salesOrderId ?? original.salesOrderId,
        paymentDate: new Date(),
        paymentType: original.paymentType,
        paymentAmount: rounded,
        status: viaProcessor ? "PENDING" : "COMPLETED",
        method: original.method ?? undefined,
        isRefund: true,
        originalPaymentId: paymentId,
        returnId: input.returnId,
        refundReason: input.reason,
        registerId: input.registerId,
        tillId: input.tillId,
        staffMemberId: input.staffMemberId,
        customerId: original.customerId,
        processorType: original.processorType,
        giftCardId: original.giftCardId,
        createdBy: input.createdBy,
      },
    });
    if (!viaProcessor) await settleRefund(tx, row.id);
    return { row, viaProcessor };
  });

  if (!reserved.viaProcessor) {
    return prisma.payment.findUniqueOrThrow({ where: { id: reserved.row.id } });
  }
  return callProcessorAndSettle(reserved.row.id);
}

/**
 * Finish a PENDING processor refund left by a crash or a processor error,
 * with the same idempotency key, so a refund that did go through is not
 * repeated.
 */
export async function retryProcessorRefund(refundPaymentId: number): Promise<Payment> {
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: refundPaymentId } });
  if (row.status === "COMPLETED") return row;
  if (!row.isRefund || row.status !== "PENDING") {
    throw new RefundError(`Payment ${refundPaymentId} is not a refund waiting on its processor.`);
  }
  if (Date.now() - row.created.getTime() > REFUND_RETRY_WINDOW_MS) {
    throw new RefundError(
      "This refund has waited on the processor for more than a day, past the window a retry is safe in. Check the processor's dashboard: if nothing went out, void it; if it did, ask an admin to settle it.",
    );
  }
  return callProcessorAndSettle(refundPaymentId);
}

async function callProcessorAndSettle(refundPaymentId: number): Promise<Payment> {
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: refundPaymentId },
    include: { originalPayment: true },
  });
  const original = row.originalPayment;
  if (!original?.processorType || !original.processorTxnId) {
    throw new RefundError(`Refund ${refundPaymentId} has no processor payment to refund.`);
  }
  const provider = getProviderForPayment(original.processorType);
  assertCapability(provider, "refunds");
  let providerRefundId: string | null;
  try {
    const result = await provider.refund!({
      providerTxnId: original.processorTxnId,
      amount: round2(Number(row.paymentAmount)),
      reason: row.refundReason ?? undefined,
      idempotencyKey: refundKey(row.id),
    });
    providerRefundId = result.refundId;
  } catch (err) {
    const message = err instanceof Error ? err.message : "The processor did not confirm the refund";
    logError(`Processor refund ${row.id} not confirmed`, err);
    throw new RefundProcessorError(
      `${message}. The refund is recorded as pending: retry it, or void it once the processor shows nothing went out.`,
    );
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: {
        status: "COMPLETED",
        paymentDate: new Date(),
        processorTxnId: providerRefundId ?? undefined,
      },
    });
    // Already settled by a concurrent retry: its side effects are done.
    if (updated.count === 1) await settleRefund(tx, row.id);
    return tx.payment.findUniqueOrThrow({ where: { id: row.id } });
  });
}

/**
 * A COMPLETED refund's consequences, once: the money goes back where it came
 * from (gift card reloaded, store credit put back), the original is marked
 * REFUNDED when nothing is left on it, and the customer's ledger moves.
 */
async function settleRefund(tx: Tx, refundPaymentId: number): Promise<void> {
  const refund = await tx.payment.findUniqueOrThrow({
    where: { id: refundPaymentId },
    include: {
      originalPayment: {
        include: { refundedPayments: { select: { paymentAmount: true, status: true } } },
      },
      salesOrder: { select: { customerId: true, orderno: true } },
    },
  });
  const original = refund.originalPayment!;
  const amount = round2(Number(refund.paymentAmount));
  const customerId = original.customerId ?? refund.salesOrder?.customerId ?? null;

  if (original.method === "GIFT_CARD" && original.giftCardId) {
    const card = await tx.giftCard.findUniqueOrThrow({ where: { id: original.giftCardId } });
    const balanceBefore = Number(card.currentBalance);
    const balanceAfter = round2(balanceBefore + amount);
    await tx.giftCardTransaction.create({
      data: {
        giftCardId: original.giftCardId,
        transactionType: "RELOAD",
        amount,
        balanceBefore,
        balanceAfter,
        notes: refund.refundReason,
        createdBy: refund.createdBy,
      },
    });
    await tx.giftCard.update({
      where: { id: original.giftCardId },
      data: { currentBalance: balanceAfter },
    });
  }

  if (original.method === "STORE_CREDIT") {
    if (customerId == null) {
      throw new RefundError(
        "This store credit payment has no customer to give the credit back to.",
      );
    }
    await issueStoreCredit(tx, {
      customerId,
      amount,
      paymentId: refund.id,
      salesOrderId: refund.salesOrderId,
      notes: refund.refundReason,
      createdBy: refund.createdBy,
    });
  }

  const refunded = original.refundedPayments
    .filter((r) => r.status === "COMPLETED" || r.status == null)
    .reduce((sum, r) => sum + Math.abs(Number(r.paymentAmount)), 0);
  if (round2(refunded) >= round2(Number(original.paymentAmount))) {
    await tx.payment.update({ where: { id: original.id }, data: { status: "REFUNDED" } });
  }

  // REFUND_ISSUED is +1 (customerLedger.signForType): money went back, so
  // the payment it reverses no longer reduces what the customer owes.
  await appendPaymentLedger(tx, {
    customerId,
    type: "REFUND_ISSUED",
    amount: signForType("REFUND_ISSUED") * amount,
    salesOrderId: refund.salesOrderId ?? undefined,
    paymentId: refund.id,
    reference: refund.salesOrder?.orderno || `refund-${refund.id}`,
    notes: refund.refundReason ?? undefined,
    createdBy: refund.createdBy,
  });
}

/**
 * A refund to the customer's store credit, written in the caller's
 * transaction: a COMPLETED refund row on `salesOrderId` (a return's own
 * order) with no processor and no till, the credit issued against it, and the
 * ledger entry. Used by lib/returns/refundReturn.ts.
 */
export async function refundToStoreCreditTx(
  tx: Tx,
  input: {
    customerId: number;
    amount: number;
    salesOrderId: number;
    returnId?: number;
    reason?: string;
    staffMemberId?: number;
    createdBy?: string;
  },
): Promise<Payment> {
  const amount = round2(input.amount);
  if (amount <= 0) throw new RefundError("Refund amount must be positive");
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: input.salesOrderId },
    select: { orderno: true },
  });
  const row = await tx.payment.create({
    data: {
      salesOrderId: input.salesOrderId,
      paymentDate: new Date(),
      paymentType: METHOD_DISPLAY.STORE_CREDIT,
      paymentAmount: amount,
      status: "COMPLETED",
      method: "STORE_CREDIT",
      isRefund: true,
      returnId: input.returnId,
      refundReason: input.reason,
      staffMemberId: input.staffMemberId,
      customerId: input.customerId,
      createdBy: input.createdBy,
    },
  });
  await issueStoreCredit(tx, {
    customerId: input.customerId,
    amount,
    paymentId: row.id,
    salesOrderId: input.salesOrderId,
    notes: input.reason,
    createdBy: input.createdBy,
  });
  await appendPaymentLedger(tx, {
    customerId: input.customerId,
    type: "REFUND_ISSUED",
    amount: signForType("REFUND_ISSUED") * amount,
    salesOrderId: input.salesOrderId,
    paymentId: row.id,
    reference: order.orderno,
    notes: input.reason,
    createdBy: input.createdBy,
  });
  return row;
}

// Called after a payment is completed (from webhook, manual entry, or POS).
// Promotes QUOTE → ORDER and creates draft purchase orders for vendor items.
export async function onPaymentReceived(orderId: number): Promise<void> {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      lineItems: {
        include: {
          product: {
            select: { id: true, vendorId: true, productNumber: true, name: true, baseCost: true },
          },
        },
      },
    },
  });

  // Promote QUOTE → ORDER on first payment
  if (order.status === "QUOTE") {
    await prisma.salesOrder.update({
      where: { id: orderId },
      data: { status: "ORDER" },
    });

    // Create service appointments for any service line items
    await syncServiceAppointments(orderId);

    // Mark consignment items as SOLD when their rug sells
    await syncConsignmentSales(orderId, order.lineItems, order.orderDate ?? new Date());
  }

  // Create draft POs grouped by vendor for items that need ordering
  const vendorItems = new Map<
    number,
    { productId: number; partNo: string; name: string; qty: number; cost: number }[]
  >();

  for (const li of order.lineItems) {
    // Only create POs for special-order items (skip floor stock)
    if (li.source === "FLOOR") continue;
    if (!li.product?.vendorId) continue;
    const vendorId = li.product.vendorId;
    if (!vendorItems.has(vendorId)) vendorItems.set(vendorId, []);
    // Use the line item's configured cost if available, otherwise fall back to
    // the product's baseCost from the catalog (populated by the pricing import)
    const lineCost = Number(li.cost || 0);
    const productCost = Number(li.product.baseCost || 0);
    vendorItems.get(vendorId)!.push({
      productId: li.product.id,
      partNo: li.product.productNumber,
      name: li.product.name,
      qty: Number(li.orderedQuantity),
      cost: lineCost > 0 ? lineCost : productCost,
    });
  }

  // Only create POs if there are vendor items and none exist yet for this order
  if (vendorItems.size > 0) {
    const existingPOs = await prisma.purchaseOrder.findMany({
      where: { salesOrderId: orderId },
      select: { id: true },
    });

    if (existingPOs.length === 0) {
      const now = new Date();
      const stamp = businessDayStamp(now, await getBusinessTimeZone());
      // Each vendor's standard lead time dates its PO; a vendor without one
      // gets no date rather than a guessed one (lib/vendorLeadTime.ts).
      const leadTimes = new Map(
        (
          await prisma.vendor.findMany({
            where: { id: { in: [...vendorItems.keys()] } },
            select: { id: true, leadTimeDays: true },
          })
        ).map((v) => [v.id, v.leadTimeDays]),
      );

      for (const [vendorId, items] of vendorItems) {
        // Generate PO number
        const poPrefix = `PO-${stamp}-`;
        const lastPO = await prisma.purchaseOrder.findFirst({
          where: { poNumber: { startsWith: poPrefix } },
          orderBy: { poNumber: "desc" },
          select: { poNumber: true },
        });
        let poSeq = 1;
        if (lastPO) {
          const lastSeq = Number.parseInt(lastPO.poNumber.replace(poPrefix, ""), 10);
          if (!Number.isNaN(lastSeq)) poSeq = lastSeq + 1;
        }
        const poNumber = `${poPrefix}${poSeq.toString().padStart(3, "0")}`;

        await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId,
            salesOrderId: orderId,
            status: "DRAFT",
            orderDate: now,
            expectedDelivery: expectedArrival(now, leadTimes.get(vendorId)),
            createdBy: order.salesperson || null,
            lineItems: {
              create: items.map((item) => ({
                productId: item.productId,
                partNo: item.partNo,
                productName: item.name,
                orderedQuantity: item.qty,
                unitCost: item.cost,
              })),
            },
          },
        });
      }
    }
  }
}

// When a return is processed, revert any consignment rugs back to ON_FLOOR.
// Mirrors syncConsignmentSales in reverse — called from the sales import runner
// when a RETURNED order is encountered.
// If the rug was already PAID to the vendor, it goes back ON_FLOOR but with
// creditOwed=true so the credit can be applied to the next vendor payment.
//
// Matches by barcode first (Marjan internal format: M1000-01), then falls back
// to customerNumber (the POS format: MAR-2000-01 → customerNumber 2000-01)
// because the two systems use different numbering.
export async function syncConsignmentReturns(
  lineItems: { productNumber?: string | null }[],
): Promise<void> {
  // Loaded once, not per line item.
  const prefixRules = await getVendorPrefixRules();
  for (const li of lineItems) {
    const pn = li.productNumber;
    if (!isVendorNumber(pn, prefixRules)) continue;

    // Try barcode match first, then customerNumber
    const barcode = toBarcode(pn!, prefixRules);
    let item = await prisma.consignmentItem.findUnique({ where: { barcode } });
    if (!item) {
      const cn = toVendorNumber(pn!, prefixRules);
      if (cn) {
        item = await prisma.consignmentItem.findFirst({ where: { customerNumber: cn } });
      }
    }
    if (!item) continue;

    if (item.status === "SOLD") {
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: {
          status: "ON_FLOOR",
          salesOrderId: null,
          saleDate: null,
          saleTransactionId: null,
          saleCustomerName: null,
        },
      });
    } else if (item.status === "PAID") {
      // Vendor already paid — revert to ON_FLOOR but flag as credit owed.
      // Preserve consignmentPaymentBatchId for audit trail.
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: {
          status: "ON_FLOOR",
          creditOwed: true,
          salesOrderId: null,
          saleDate: null,
          saleTransactionId: null,
          saleCustomerName: null,
        },
      });
    }
  }
}

// When a sale is confirmed, check if any line items are consignment rugs
// and mark the corresponding ConsignmentItem as SOLD with the SalesOrder link.
async function syncConsignmentSales(
  orderId: number,
  lineItems: { product: { id: number; productNumber: string } | null }[],
  orderDate: Date,
): Promise<void> {
  // Loaded once, not per line item.
  const prefixRules = await getVendorPrefixRules();
  for (const li of lineItems) {
    if (!li.product) continue;
    const pn = li.product.productNumber;
    if (!isVendorNumber(pn, prefixRules)) continue;
    const barcode = toBarcode(pn, prefixRules);

    const item = await prisma.consignmentItem.findUnique({ where: { barcode } });
    if (!item) continue;

    // PAID item appearing on a new sale with creditOwed: the re-sale cancels
    // the credit (exchange or return-and-rebuy). Clear creditOwed but keep PAID.
    if (item.status === "PAID" && item.creditOwed) {
      await prisma.consignmentItem.update({
        where: { barcode },
        data: { creditOwed: false },
      });
      continue;
    }

    // Skip items already in a terminal sale state
    if (item.status === "SOLD" || item.status === "PAID") continue;

    // When a previously-returned item re-sells, clear creditOwed
    await prisma.consignmentItem.update({
      where: { barcode },
      data: {
        status: "SOLD",
        salesOrderId: orderId,
        saleDate: orderDate,
        ...(item.creditOwed ? { creditOwed: false } : {}),
      },
    });
  }
}

export async function calculateTillExpected(tillId: number): Promise<{
  cash: number;
  card: number;
  check: number;
  giftCard: number;
  storeCredit: number;
  other: number;
  total: number;
  expectedCash: number;
}> {
  const till = await prisma.till.findUniqueOrThrow({
    where: { id: tillId },
    select: { openingCash: true },
  });

  // Money that moved: not VOIDED, FAILED or PENDING (a PENDING refund has not
  // left the drawer or the card yet). NULL-safe, rule 51.
  const payments = await prisma.payment.findMany({
    where: { tillId, ...countedPaymentWhere() },
    select: { method: true, paymentAmount: true, isRefund: true },
  });

  const buckets: Record<string, number> = {
    CASH: 0,
    CARD: 0,
    CHECK: 0,
    GIFT_CARD: 0,
    STORE_CREDIT: 0,
  };

  for (const p of payments) {
    const key = p.method ?? "OTHER";
    const amt = Number(p.paymentAmount);
    const signed = p.isRefund ? -Math.abs(amt) : amt;
    if (key in buckets) {
      buckets[key] = round2(buckets[key] + signed);
    } else {
      buckets["OTHER"] = round2((buckets["OTHER"] ?? 0) + signed);
    }
  }

  // Cash in the drawer includes the opening float
  const cashNet = round2(Number(till.openingCash) + buckets["CASH"]);

  return {
    cash: cashNet,
    card: buckets["CARD"],
    check: buckets["CHECK"],
    giftCard: buckets["GIFT_CARD"],
    storeCredit: buckets["STORE_CREDIT"],
    other: buckets["OTHER"] ?? 0,
    total: round2(
      cashNet +
        buckets["CARD"] +
        buckets["CHECK"] +
        buckets["GIFT_CARD"] +
        buckets["STORE_CREDIT"] +
        (buckets["OTHER"] ?? 0),
    ),
    expectedCash: cashNet,
  };
}
