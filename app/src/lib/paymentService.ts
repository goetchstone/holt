// /app/src/lib/paymentService.ts
import { getAppSettings } from "@/lib/appSettings";
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
import { reportOpsAlert } from "@/lib/opsAlert";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { countedPaymentWhere, isPaymentExcludedFromBalance } from "@/lib/paymentBalance";
import { isCountedLine } from "@/lib/salesOrderRevenue";
import { issueStoreCredit, spendStoreCredit } from "@/lib/customerCredit";
import { refundCounts } from "@/lib/returns/returnMoney";
import { raiseSpecialOrderPos } from "@/lib/sales/salePos";
import type { Payment, Prisma } from "@prisma/client";
import { expectedArrival } from "@/lib/vendorLeadTime";
import { createNumberedPurchaseOrder } from "@/lib/purchasing/poNumber";
import { promoteQuoteToOrder } from "@/lib/sales/quoteHolds";
import { resolveTenderPayment } from "@/lib/payments/tenders";
import { creditToCard, GiftCardError, spendFromCard } from "@/lib/giftCardLedger";
// A cycle (giftCardLines reads computeBalance from here), safe because neither module uses the
// other's exports while it loads, only when a payment runs.
import { issuePaidGiftCards } from "@/lib/sales/giftCardLines";
import { applyInvoiceCardPayment } from "@/lib/billing/invoiceService";

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
  /** A store tender (lib/payments/tenders.ts): it decides the method and label. */
  tenderId?: number;
  /** What the payer quotes: a finance approval number, a wire reference. */
  reference?: string;
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

/** Only a PENDING payment can be voided; anything else answers 409 with this message. */
export class VoidError extends Error {}

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

/**
 * The method and label a payment is recorded under. A store tender decides
 * both (lib/payments/tenders.ts), whatever method the caller sent; a built-in
 * method is labelled from METHOD_DISPLAY.
 */
async function labelPayment(tx: Tx, input: RecordPaymentInput) {
  if (input.tenderId != null) {
    return resolveTenderPayment(tx, input.tenderId, input.reference);
  }
  return {
    method: input.method,
    paymentType: METHOD_DISPLAY[input.method] ?? input.method,
    tenderId: null,
    reference: input.reference?.trim() || null,
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
    select: { id: true, orderno: true, customerId: true, status: true },
  });
  if (order.status === "CANCELLED") {
    throw new Error("This order is cancelled, so it can't take a payment.");
  }

  if (input.tillId) {
    const till = await tx.till.findUniqueOrThrow({ where: { id: input.tillId } });
    if (till.status !== "OPEN") {
      throw new Error(`Till ${input.tillId} is not open (status: ${till.status})`);
    }
  }

  const { method, paymentType, tenderId, reference } = await labelPayment(tx, input);

  if (method === "GIFT_CARD") {
    if (!input.giftCardId) {
      throw new Error("giftCardId is required for gift card payments");
    }
    // One locked, conditional change (lib/giftCardLedger.ts): a closed card or one short of the
    // amount is refused, two spends of one balance can't both pass, and $0 is REDEEMED.
    await spendFromCard(tx, {
      cardId: input.giftCardId,
      amount: rounded,
      createdBy: input.createdBy ?? null,
      reference: order.orderno ? "Order " + order.orderno : "Order #" + String(orderId),
    });
  }

  // Store credit is the order's own customer's (spendStoreCredit refuses
  // anyone else's), so the customer defaults to the order's.
  const creditCustomerId =
    method === "STORE_CREDIT" ? (input.customerId ?? order.customerId ?? null) : null;
  if (method === "STORE_CREDIT" && creditCustomerId == null) {
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
      method: method as any,
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
      tenderId,
      reference,
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

  // A gift card sold on the sale goes live with the payment that pays it off, in this
  // transaction: a card refused (retired, or its number issued by another sale, since it was
  // rung up) refuses the payment too, so staff see it at the register.
  await issuePaidGiftCards(tx, orderId, input.createdBy ?? null);

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

/**
 * How long a checkout the processor said was paid, but Holt couldn't post
 * (`processorConfirmedAt`), waits for the processor's retry before
 * `sweepStalePendingPayments` lets it go: Stripe retries a webhook it got an
 * error for over up to three days in live mode. After that no retry is
 * coming, so the row is failed with an alert to record the money by hand or
 * refund it, and the order or invoice can take a new link again.
 */
export const PROCESSOR_RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface ActivePendingPayment {
  id: number;
  amount: number;
  createdAt: Date;
  ageMinutes: number;
  /** The processor said it was paid and it hasn't posted yet (`processorConfirmedAt`). */
  paidAtProcessor: boolean;
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
 *
 * A checkout the processor has said was paid, waiting to post
 * (`processorConfirmedAt`), counts at any age: the customer has paid it.
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
      OR: [{ paymentDate: { gte: cutoff } }, { processorConfirmedAt: { not: null } }],
    },
    orderBy: [{ processorConfirmedAt: { sort: "asc", nulls: "last" } }, { paymentDate: "desc" }],
  });
  if (!pending) return null;
  return {
    id: pending.id,
    amount: Number(pending.paymentAmount),
    createdAt: pending.paymentDate,
    ageMinutes: Math.max(0, Math.round((Date.now() - pending.paymentDate.getTime()) / 60_000)),
    paidAtProcessor: pending.processorConfirmedAt !== null,
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
 *
 * The move is one conditional UPDATE (WHERE status = PENDING): a webhook's
 * completePayment landing at the same moment holds the row, and this then
 * finds it COMPLETED and refuses, instead of voiding a payment whose ledger
 * entry just posted. A checkout the processor has said was paid
 * (`processorConfirmedAt`) is never voided, by this or by a forced new link:
 * the customer has paid it, and a new link would charge them twice. A refund waiting on its processor can't be voided while
 * the processor has the call: callProcessorAndSettle holds the payment's
 * refund lock for it, so money can't go out with the row voided.
 */
export async function voidPendingPayment(
  paymentId: number,
  opts: { voidedBy?: string | null; reason?: string } = {},
): Promise<Payment> {
  const notPending = (status: string | null) =>
    new VoidError(
      `Only a pending payment can be voided; payment ${paymentId} is ${(status ?? "without a status").toLowerCase()}.`,
    );
  // No "refund it at the processor" here: the row is still waiting, and the processor's next
  // try would record a payment the customer had been given back. That is the sweep's alert,
  // once the retries have stopped and the row is failed.
  const paidAtProcessor = new VoidError(
    `The card processor says payment ${paymentId} went through, so it can't be voided. Fix what ` +
      "stopped it being recorded (an alert said why), and the processor's next try records it.",
  );
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.status !== "PENDING") throw notPending(payment.status);
    if (payment.processorConfirmedAt !== null) throw paidAtProcessor;
    if (payment.isRefund && payment.originalPaymentId !== null) {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${REFUND_LOCK_SPACE}::int, ${payment.originalPaymentId}::int) AS locked`;
      if (!lock.locked) {
        throw new VoidError(
          "This refund is with the card processor right now. Wait for it to finish, then look at it again.",
        );
      }
    }
    const moved = await tx.payment.updateMany({
      where: { id: paymentId, status: "PENDING", processorConfirmedAt: null },
      data: {
        status: "VOIDED",
        updatedBy: opts.voidedBy ?? undefined,
        processorData: opts.reason ? { voidReason: opts.reason } : undefined,
      },
    });
    if (moved.count === 0) {
      // Moved since the read above: completed, voided by another request, or
      // marked paid at the processor by a completion that couldn't post.
      const now = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { status: true, processorConfirmedAt: true },
      });
      if (now.status === "PENDING" && now.processorConfirmedAt !== null) throw paidAtProcessor;
      throw notPending(now.status);
    }
    if (payment.salesOrderId !== null) {
      await tx.orderChangeLog.create({
        data: {
          salesOrderId: payment.salesOrderId,
          changeType: "PAYMENT_VOIDED",
          previousValue: String(payment.paymentAmount),
          reason: opts.reason ?? null,
          changedBy: opts.voidedBy ?? null,
        },
      });
    }
    return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
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
    const what = "orderId" in target ? "order" : "invoice";
    super(
      existing.paidAtProcessor
        ? `The card processor says the $${existing.amount.toFixed(2)} payment on this ${what} ` +
            `went through, but it hasn't been recorded yet (an alert said why). It can't be ` +
            `replaced with a new link: fix what stopped it, and the processor's next try ` +
            `records it. If it isn't recorded within three days, Holt alerts again and this ` +
            `${what} can take a new link.`
        : `A payment link for $${existing.amount.toFixed(2)} is already open on this ` +
            `${what} (started ${existing.ageMinutes} min ` +
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
    // A checkout the customer has paid is never voided for a new one: they would pay twice.
    if (!input.force || existing.paidAtProcessor) {
      throw new CheckoutAlreadyOpenError(existing, input.target);
    }
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
 * Idempotent by construction: only a currently-PENDING checkout transitions,
 * in one conditional UPDATE, so a completion landing at the same moment holds
 * the row and this then finds it COMPLETED and leaves it. Returns null
 * (rather than throwing) when the row isn't PENDING anymore — a real race the
 * sweeper and the webhook can both hit (the customer pays at the exact moment
 * the row goes stale), and "already resolved, leave it alone" is correct, not
 * an error. Never a PENDING refund: it waits on a processor that may have
 * paid it out. Never a checkout the processor has said was paid
 * (`processorConfirmedAt`): it waits for its completion to post.
 */
export async function expirePendingPayment(paymentId: number): Promise<Payment | null> {
  const moved = await prisma.payment.updateMany({
    where: { id: paymentId, status: "PENDING", isRefund: false, processorConfirmedAt: null },
    data: { status: "FAILED" },
  });
  if (moved.count === 0) return null;
  return prisma.payment.findUnique({ where: { id: paymentId } });
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
    // out, and failing it would let the same money be refunded again. Never a
    // checkout the processor has said was paid: failing it would leave the
    // money with no record, and the processor's retry finding nothing to post.
    where: {
      status: "PENDING",
      isRefund: false,
      paymentDate: { lt: cutoff },
      processorConfirmedAt: null,
    },
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

  // A checkout the processor said was paid but Holt couldn't post waits for
  // the processor's retry, then is let go with an alert: no retry is coming,
  // and the money needs recording by hand (or refunding at the processor).
  const retryCutoff = new Date(Date.now() - PROCESSOR_RETRY_WINDOW_MS);
  const unposted = await prisma.payment.findMany({
    where: { status: "PENDING", isRefund: false, processorConfirmedAt: { lt: retryCutoff } },
    select: {
      id: true,
      salesOrderId: true,
      invoiceId: true,
      paymentAmount: true,
      paymentDate: true,
      processorConfirmedAt: true,
      processorType: true,
    },
  });
  for (const p of unposted) {
    const moved = await prisma.payment.updateMany({
      where: { id: p.id, status: "PENDING", processorConfirmedAt: { lt: retryCutoff } },
      data: { status: "FAILED" },
    });
    if (moved.count === 0) continue;
    const amount = Number(p.paymentAmount);
    const on = p.invoiceId !== null ? `invoice ${p.invoiceId}` : `order ${p.salesOrderId}`;
    await reportOpsAlert({
      title: "Card payment taken but never recorded",
      detail:
        `The card processor took $${amount.toFixed(2)} for ${on} and Holt couldn't record it ` +
        `(an earlier alert said why); the processor has stopped retrying. Payment ${p.id} is ` +
        `now marked failed, so ${on} can take a new link. Record the money by hand, or refund ` +
        `it at the processor.`,
      context: {
        paymentId: p.id,
        amount,
        salesOrderId: p.salesOrderId,
        invoiceId: p.invoiceId,
        processorType: p.processorType,
        confirmedAt: p.processorConfirmedAt,
      },
    });
    swept.push({
      id: p.id,
      salesOrderId: p.salesOrderId,
      amount,
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
 * A processor webhook says a checkout was paid and there is no PENDING row
 * for it. Usually that is a retry of one already COMPLETED, and stays silent.
 * But ending a PENDING row's life in Holt does not close the session at the
 * processor: a `force` replacement or an operator's void (VOIDED), or the
 * stale sweep (FAILED, where Square has no expiry event), leaves it payable.
 * If the customer pays it anyway the money is at the processor and nothing is
 * in the books, so raise an ops alert naming the row. Never records the
 * payment itself: whether it is the only charge or a second one is a
 * person's call, to record or to refund. Both webhooks call this; returns
 * whether it alerted.
 */
export async function reportUntrackedCheckoutPaid(
  providerTxnId: string,
  processorName: string,
): Promise<boolean> {
  const dropped = await prisma.payment.findFirst({
    where: {
      processorTxnId: providerTxnId,
      isRefund: false,
      status: { in: ["VOIDED", "FAILED"] },
    },
    orderBy: { paymentDate: "desc" },
    select: { id: true, status: true, paymentAmount: true, salesOrderId: true, invoiceId: true },
  });
  if (!dropped) return false;

  const amount = round2(Number(dropped.paymentAmount));
  const target = dropped.invoiceId
    ? `invoice ${dropped.invoiceId}`
    : `order ${dropped.salesOrderId ?? "(none)"}`;
  await reportOpsAlert({
    title: `${processorName} took a payment Holt had stopped tracking`,
    detail:
      `${processorName} reports a paid checkout of $${amount.toFixed(2)} for ${target}, ` +
      `but Holt had marked payment ${dropped.id} ${dropped.status}. The money was taken ` +
      `and never posted to the books. Record it against the ${target}, or refund it at ` +
      `${processorName}.`,
    context: {
      paymentId: dropped.id,
      status: dropped.status,
      amount,
      salesOrderId: dropped.salesOrderId,
      invoiceId: dropped.invoiceId,
      providerTxnId,
    },
  });
  return true;
}

/**
 * Mark a PENDING checkout COMPLETED and post everything it pays, in one
 * transaction — called when a processor webhook confirms the charge: the
 * AR-ledger entry, an order's gift cards, and for an invoice's checkout its
 * application and AR_PAYMENT journal (applyInvoiceCardPayment). If any of it
 * fails, none of it is written and the row stays PENDING, marked
 * `processorConfirmedAt` so the stale sweep, a void and a forced new checkout
 * leave it alone: the processor's retry finds it and posts it whole once
 * whatever stopped it is fixed. Once the processor's retries run out
 * (PROCESSOR_RETRY_WINDOW_MS) the sweep fails it with an alert, for a person
 * to record by hand. (#137)
 *
 * The move is one conditional UPDATE (WHERE status = PENDING), and only the
 * call that makes it writes the rest: of two deliveries at once (Square sends
 * payment.created and payment.updated; Stripe redelivers), the second waits
 * on the first's row lock, then finds it COMPLETED and writes nothing. Returns
 * null whenever this call didn't complete it: already COMPLETED (a repeat), or
 * VOIDED or FAILED meanwhile, which the webhook reports
 * (reportUntrackedCheckoutPaid) rather than records.
 *
 * `metadataInvoiceId` is the invoice the webhook's metadata names: only a
 * cross-check of the row's own binding, and a mismatch refuses the whole
 * completion.
 */
export async function completePayment(
  paymentId: number,
  extraData?: {
    processorData?: Record<string, unknown>;
    cardLast4?: string;
    cardBrand?: string;
  },
  opts: { metadataInvoiceId?: number } = {},
): Promise<Payment | null> {
  try {
    return await completeInOneTransaction(paymentId, extraData, opts);
  } catch (err) {
    // Nothing posted, and the processor has the money: mark the row so nothing ends it before
    // the retry posts it. Its own write, after the rollback; a failure here is logged and the
    // completion's own error is what the webhook reports.
    await prisma.payment
      .updateMany({
        where: { id: paymentId, status: "PENDING", isRefund: false, processorConfirmedAt: null },
        data: { processorConfirmedAt: new Date() },
      })
      .catch((markErr) =>
        logError(`Could not mark payment ${paymentId} as paid at the processor`, markErr),
      );
    throw err;
  }
}

async function completeInOneTransaction(
  paymentId: number,
  extraData: Parameters<typeof completePayment>[1],
  opts: { metadataInvoiceId?: number },
): Promise<Payment | null> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.payment.updateMany({
      where: { id: paymentId, status: "PENDING", isRefund: false },
      data: {
        status: "COMPLETED",
        processorData: (extraData?.processorData as object) ?? undefined,
        cardLast4: extraData?.cardLast4,
        cardBrand: extraData?.cardBrand,
      },
    });
    if (moved.count === 0) return null;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

    // Before the ledger entry: the invoice's row is locked ahead of the
    // customer's, in the order every invoice writer takes them.
    if (payment.invoiceId !== null || opts.metadataInvoiceId !== undefined) {
      await applyInvoiceCardPayment(tx, paymentId, opts.metadataInvoiceId);
    }

    const order = payment.salesOrderId
      ? await tx.salesOrder.findUnique({
          where: { id: payment.salesOrderId },
          select: { orderno: true, customerId: true },
        })
      : null;

    await appendPaymentLedger(tx, {
      customerId: payment.customerId ?? order?.customerId ?? null,
      type: "PAYMENT",
      amount: -round2(Number(payment.paymentAmount)),
      salesOrderId: payment.salesOrderId ?? undefined,
      paymentId: payment.id,
      reference: order?.orderno || `order-${payment.salesOrderId}`,
      createdBy: payment.createdBy ?? undefined,
    });

    // The processor's payment can pay the sale off too: its gift cards go live with it, as at
    // the register (recordPaymentTx). The processor has the money already, so a card that can't
    // be issued doesn't refuse the payment: no retry would ever succeed, and the money would be
    // missing from the books. Its line stays unissued, with why on the order, for staff to cancel.
    if (payment.salesOrderId != null) {
      await issuePaidGiftCards(tx, payment.salesOrderId, payment.createdBy ?? null, "leave");
    }

    return payment;
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
 *   2. Call the processor, with an idempotency key that is the refund row's
 *      id, holding the payment's lock again (callProcessorAndSettle) in a
 *      transaction that has written nothing: the row is already the record.
 *   3. Settle, still under that lock: PENDING -> COMPLETED with the
 *      processor's refund id, ledger entry and side effects.
 * A crash between 2 and 3 leaves the PENDING row as the record, and
 * retryProcessorRefund finishes it with the same key. While the processor
 * has the call the refund can't be voided (voidPendingPayment).
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
        // Back to the same store tender, so its total nets the refund.
        tenderId: original.tenderId,
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

/**
 * How long the transaction around a processor refund call may stay open. The
 * provider's requests are bounded well inside it (REFUND_REQUEST_TIMEOUT_MS:
 * one minute for Square's two; about two for Stripe's two tried twice when
 * Stripe stops answering, its limit being the SDK's idle timeout), because the
 * refund lock lives only as long as this transaction: if it
 * timed out with the call still running, the lock would be gone and the refund
 * could be voided while the processor paid it out. Should it run out anyway,
 * the transaction rolls back having written nothing, and the PENDING row the
 * reserve committed is the record, for a retry with the same key. The
 * provider's credential lookup takes a second pooled connection, so a pool
 * held to one connection would wait here for this transaction to end.
 */
const REFUND_CALL_TX = { maxWait: 10_000, timeout: 5 * 60_000 };

/**
 * Steps 2 and 3 of processRefund, holding the payment's refund lock from
 * before the call until the refund is settled: the lock voidPendingPayment
 * tries before it voids a refund, so a refund the processor is paying out
 * can't be voided under it (money gone, no ledger row, and the cap freed to
 * refund it again), and a second retry waits and then finds it settled. The
 * transaction writes nothing before the call; the PENDING row was committed
 * by the reserve, so a crash or a timeout here leaves that row as the record.
 */
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
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_LOCK_SPACE}::int, ${original.id}::int)`;
    const now = await tx.payment.findUniqueOrThrow({ where: { id: row.id } });
    // A retry that got the lock first settled it.
    if (now.status === "COMPLETED") return now;
    if (now.status !== "PENDING") {
      throw new RefundError(
        `Refund ${row.id} was ${(now.status ?? "changed").toLowerCase()} before it went to the processor, so nothing was sent.`,
      );
    }
    let providerRefundId: string | null;
    try {
      const result = await provider.refund!({
        providerTxnId: original.processorTxnId!,
        amount: round2(Number(row.paymentAmount)),
        reason: row.refundReason ?? undefined,
        idempotencyKey: refundKey(row.id),
      });
      providerRefundId = result.refundId;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The processor did not confirm the refund";
      logError(`Processor refund ${row.id} not confirmed`, err);
      throw new RefundProcessorError(
        `${message}. The refund is recorded as pending: retry it, or void it once the processor shows nothing went out.`,
      );
    }
    // Still PENDING: everything that changes a refund's status holds this lock.
    await tx.payment.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        paymentDate: new Date(),
        processorTxnId: providerRefundId ?? undefined,
      },
    });
    await settleRefund(tx, row.id);
    return tx.payment.findUniqueOrThrow({ where: { id: row.id } });
  }, REFUND_CALL_TX);
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
    // Back onto the card it came off, unless the card was retired: then staff refund it
    // another way (owner, 2026-11-11), and nothing here moves.
    try {
      await creditToCard(tx, {
        cardId: original.giftCardId,
        amount,
        type: "REFUND",
        createdBy: refund.createdBy,
        reference: "Refund of payment #" + String(original.id),
        notes: refund.refundReason,
      });
    } catch (err) {
      if (err instanceof GiftCardError) {
        throw new RefundError(err.message + " Refund it to store credit instead.");
      }
      throw err;
    }
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

/**
 * A processor webhook's steps after its payment posted (onPaymentReceived: a quote becomes an
 * order, its purchase orders are raised). Not money, and never retried: the processor's retry
 * finds the payment COMPLETED and posts nothing. So a failure is reported for a person to
 * finish from the order, and the webhook still answers 200. It used to answer 500 with an
 * alert saying the payment hadn't reached the ledger, when it had.
 */
export async function followUpWebhookPayment(
  salesOrderId: number,
  processorName: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await onPaymentReceived(salesOrderId);
  } catch (err) {
    logError(`${processorName} webhook: payment posted, its follow-up steps failed`, err, {
      salesOrderId,
      ...context,
    });
    await reportOpsAlert({
      title: `${processorName} payment posted; the order's next steps didn't run`,
      detail:
        "The payment and its ledger entry are recorded. Turning the quote into an order, or raising its purchase orders, failed, and the processor's retry won't run it again: finish it from the order.",
      context: { salesOrderId, ...context },
    });
  }
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

  // Promote QUOTE → ORDER on first payment. Its lines all commit stock now: a
  // quote committed only the ones it held (GAP-16, lib/sales/quoteHolds.ts).
  // Only the call that moves the status runs the follow-ups below.
  const promoted =
    order.status === "QUOTE" &&
    (await prisma.$transaction((tx) => promoteQuoteToOrder(tx, orderId)));
  if (promoted) {
    // Create service appointments for any service line items
    await syncServiceAppointments(orderId);

    // Mark consignment items as SOLD when their rug sells
    await syncConsignmentSales(orderId, order.lineItems, order.orderDate ?? new Date());
  }

  // A special order has a PO from the moment it goes ahead.
  await raiseSpecialOrderPos(orderId);
}

/**
 * The follow-ups for a sale that went ahead some other way than a first payment: the
 * status route promotes it itself, when the store allows a sale with nothing paid.
 */
export async function onSaleWentAhead(orderId: number): Promise<void> {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      lineItems: { include: { product: { select: { id: true, productNumber: true } } } },
    },
  });
  await syncServiceAppointments(orderId);
  await syncConsignmentSales(orderId, order.lineItems, order.orderDate ?? new Date());
  await raiseSpecialOrderPos(orderId);
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
  /** `other` by payment type, so a store tender (each finance company, Zelle)
   *  shows under its own name. */
  otherByType: { label: string; amount: number }[];
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
    select: { method: true, paymentType: true, paymentAmount: true, isRefund: true },
  });

  const buckets: Record<string, number> = {
    CASH: 0,
    CARD: 0,
    CHECK: 0,
    GIFT_CARD: 0,
    STORE_CREDIT: 0,
    OTHER: 0,
  };
  const otherByType = new Map<string, number>();

  for (const p of payments) {
    const key = p.method ?? "OTHER";
    const amt = Number(p.paymentAmount);
    const signed = p.isRefund ? -Math.abs(amt) : amt;
    if (key !== "OTHER" && key in buckets) {
      buckets[key] = round2(buckets[key] + signed);
    } else {
      buckets["OTHER"] = round2((buckets["OTHER"] ?? 0) + signed);
      const label = p.paymentType || METHOD_DISPLAY.OTHER;
      otherByType.set(label, round2((otherByType.get(label) ?? 0) + signed));
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
    otherByType: [...otherByType]
      .map(([label, amount]) => ({ label, amount }))
      .sort((a, b) => a.label.localeCompare(b.label)),
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
