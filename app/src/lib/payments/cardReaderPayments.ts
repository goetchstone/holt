// /app/src/lib/payments/cardReaderPayments.ts
//
// A card payment taken on a register's reader, from "send it to the reader" to
// the payment in the books.
//
//   start    the processor is handed the payment for the reader, and a PENDING
//            Payment row is written: no ledger entry, exactly like a payment
//            link that has not been paid (recordPendingPayment).
//   settle   the register asks how it went. Approved: completePayment posts it
//            (the row COMPLETED, the ledger entry, gift cards) in one
//            transaction, the same function a paid link goes through. Declined
//            or failed: the payment is cancelled at the processor and the row
//            FAILED. Still waiting: nothing changes.
//   cancel   the reader is cleared and the payment cancelled at the processor.
//            If the card had already gone through, it is recorded, not voided.
//
// The processor's `payment_intent.succeeded` webhook completes the same row
// when the register is not there to ask (pages/api/stripe/webhook.ts). Both
// can run at once: completePayment moves the row with one conditional update,
// so only one of them posts it.
//
// NOT YET RUN AGAINST STRIPE OR A READER (docs/domains/pos.md, "Card readers").

import type { Payment } from "@prisma/client";
import { ApiError } from "@/lib/apiResponse";
import { getAppSettings } from "@/lib/appSettings";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { assertCapability, getProviderForPayment } from "@/lib/payments";
import { isSimulatedReader, processorRefusal, readerAtRegister } from "@/lib/payments/cardReaders";
import {
  calculateOrderBalance,
  completePayment,
  expirePendingPayment,
  findActivePendingPayment,
  followUpWebhookPayment,
  recordPendingPayment,
  round2,
  voidPendingPayment,
  VoidError,
} from "@/lib/paymentService";

export type ReaderPaymentStatus = "WAITING" | "APPROVED" | "DECLINED" | "CANCELED";

export interface ReaderPaymentState {
  paymentId: number;
  status: ReaderPaymentStatus;
  amount: number;
  /** DECLINED: why. WAITING after a cancel: why it could not be stopped. */
  message?: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
}

interface ReaderPaymentData {
  cardReader: true;
  readerId: string;
  failure?: string;
}

/** The reader a payment was sent to, or null when the row is not a reader payment. */
function readerDataOf(payment: Pick<Payment, "processorData">): ReaderPaymentData | null {
  const data = payment.processorData as Record<string, unknown> | null;
  if (!data || data.cardReader !== true || typeof data.readerId !== "string") return null;
  return data as unknown as ReaderPaymentData;
}

function stateOf(payment: Payment, status: ReaderPaymentStatus, message?: string) {
  return {
    paymentId: payment.id,
    status,
    amount: Number(payment.paymentAmount),
    message,
    cardBrand: payment.cardBrand,
    cardLast4: payment.cardLast4,
  } satisfies ReaderPaymentState;
}

async function loadReaderPayment(paymentId: number): Promise<{
  payment: Payment;
  reader: ReaderPaymentData;
}> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  const reader = payment && !payment.isRefund ? readerDataOf(payment) : null;
  if (!payment || !reader || !payment.processorTxnId) {
    throw new ApiError(404, "That isn't a card reader payment.");
  }
  return { payment, reader };
}

/** What a row that is no longer PENDING says happened. */
function settledState(payment: Payment, reader: ReaderPaymentData): ReaderPaymentState {
  if (payment.status === "COMPLETED" || payment.status === "REFUNDED") {
    return stateOf(payment, "APPROVED");
  }
  if (payment.status === "VOIDED") return stateOf(payment, "CANCELED");
  return stateOf(payment, "DECLINED", reader.failure ?? "The payment didn't go through.");
}

/**
 * Ask the processor how a reader payment went, and record the answer. Safe to
 * call as often as the register likes, and alongside the webhook.
 */
export async function settleReaderPayment(paymentId: number): Promise<ReaderPaymentState> {
  const { payment, reader } = await loadReaderPayment(paymentId);
  if (payment.status !== "PENDING") return settledState(payment, reader);

  const provider = getProviderForPayment(payment.processorType);
  assertCapability(provider, "terminal");
  let result;
  try {
    result = await provider.getTerminalCheckout!(payment.processorTxnId!, reader.readerId);
  } catch (err) {
    throw processorRefusal(`${provider.displayName} couldn't say how the card payment went`, err);
  }

  if (result.status === "PENDING") return stateOf(payment, "WAITING");

  if (result.status === "COMPLETED") {
    // Throws when the books can't take it: the row stays PENDING, marked paid
    // at the processor, and the next ask (or the webhook) posts it.
    const completed = await completePayment(paymentId, {
      processorData: { ...result.processorData, cardReader: true, readerId: reader.readerId },
      cardLast4: result.cardLast4,
      cardBrand: result.cardBrand,
    });
    if (completed?.salesOrderId) {
      await followUpWebhookPayment(completed.salesOrderId, provider.displayName, { paymentId });
    }
    const now = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    return settledState(now, reader);
  }

  // Declined, failed or cancelled at the processor. A declined payment is
  // still payable there until it is cancelled, so cancel it before the row
  // stops tracking it: the next try is a new payment, never a second charge.
  const message =
    result.status === "CANCELED"
      ? "The payment was cancelled."
      : (result.message ?? "The payment didn't go through.");
  if (result.status === "FAILED") {
    await provider.cancelTerminalCheckout!(payment.processorTxnId!, reader.readerId);
    const after = await provider.getTerminalCheckout!(payment.processorTxnId!, reader.readerId);
    if (after.status === "COMPLETED" || after.status === "PENDING") {
      // It could not be cancelled: it is being paid, or was. Ask again.
      return stateOf(payment, "WAITING");
    }
  }
  const failed = await expirePendingPayment(paymentId);
  if (failed) {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { processorData: { ...reader, failure: message } },
    });
  }
  const now = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return settledState(now, { ...reader, failure: message });
}

export interface StartReaderPaymentInput {
  amount: number;
  registerId: number;
  tillId?: number;
  staffMemberId?: number;
  actor: string | null;
}

export interface StartedReaderPayment extends ReaderPaymentState {
  readerLabel: string;
  /** A test-mode reader with no hardware: the register offers to present a test card. */
  simulated: boolean;
}

/**
 * Send a card payment for an order to the reader at a register. Refuses,
 * before anything reaches the reader: an amount over what the order owes, a
 * register with no reader, a closed till, and an order with a payment link
 * still open (both could be paid).
 */
export async function startReaderPayment(
  orderId: number,
  input: StartReaderPaymentInput,
): Promise<StartedReaderPayment> {
  const amount = round2(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, "The amount must be more than zero.");
  }
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    select: { orderno: true, status: true },
  });
  if (!order) throw new ApiError(404, "That order doesn't exist.");
  if (order.status === "CANCELLED") {
    throw new ApiError(409, "This order is cancelled, so it can't take a payment.");
  }

  const reader = await readerAtRegister(input.registerId);
  if (!reader) {
    throw new ApiError(
      409,
      "This register has no card reader. Set one up in Admin > Setup > Card readers.",
    );
  }
  const describe = (state: ReaderPaymentState): StartedReaderPayment => ({
    ...state,
    readerLabel: reader.label,
    simulated: isSimulatedReader(reader),
  });

  if (input.tillId) {
    const till = await prisma.till.findUnique({
      where: { id: input.tillId },
      select: { status: true },
    });
    if (till?.status !== "OPEN") {
      throw new ApiError(409, "This register's till isn't open. Open it before taking a payment.");
    }
  }

  // One payment in flight per order. A reader payment already out is picked
  // up where it stands instead of sending the reader a second one.
  const open = await findActivePendingPayment({ orderId });
  if (open) {
    const existing = await prisma.payment.findUniqueOrThrow({ where: { id: open.id } });
    if (!readerDataOf(existing)) {
      throw new ApiError(
        409,
        `A payment link for $${open.amount.toFixed(2)} is still open on this order. ` +
          "Void it on the order before taking the card here, or the customer could pay twice.",
      );
    }
    const state = await settleReaderPayment(existing.id);
    if (state.status === "WAITING" || state.status === "APPROVED") return describe(state);
  }

  const { balanceDue } = await calculateOrderBalance(orderId);
  if (amount > round2(balanceDue)) {
    throw new ApiError(
      400,
      `The order owes $${round2(balanceDue).toFixed(2)}; a card can't be charged more than that.`,
    );
  }

  const provider = getProviderForPayment(reader.processorType);
  assertCapability(provider, "terminal");
  const settings = await getAppSettings();
  let checkout;
  try {
    checkout = await provider.createTerminalCheckout!({
      amount,
      currency: settings.currency || "USD",
      deviceId: reader.processorReaderId,
      referenceId: order.orderno ? `Order ${order.orderno}` : `Order #${orderId}`,
      metadata: { orderId: String(orderId) },
    });
  } catch (err) {
    throw processorRefusal(`The reader "${reader.label}" didn't take the payment`, err);
  }

  let pending: Payment;
  try {
    pending = await recordPendingPayment(
      { orderId },
      {
        method: "CARD",
        amount,
        processorType: provider.id.toUpperCase(),
        processorTxnId: checkout.providerTxnId,
        processorData: { cardReader: true, readerId: reader.processorReaderId },
        registerId: input.registerId,
        tillId: input.tillId,
        staffMemberId: input.staffMemberId,
        createdBy: input.actor,
      },
    );
  } catch (err) {
    // The reader has a payment Holt has no record of: take it back.
    await provider.cancelTerminalCheckout!(checkout.providerTxnId, reader.processorReaderId).catch(
      (cancelErr) =>
        logError("A reader payment could not be recorded or cancelled", cancelErr, {
          orderId,
          providerTxnId: checkout.providerTxnId,
        }),
    );
    throw err;
  }
  return describe(stateOf(pending, "WAITING"));
}

/**
 * Stop a reader payment the customer has not completed. A card that went
 * through first is recorded, and one being authorized can't be stopped: both
 * come back as what they are, never as cancelled.
 */
export async function cancelReaderPayment(
  paymentId: number,
  actor: string | null,
): Promise<ReaderPaymentState> {
  const { payment, reader } = await loadReaderPayment(paymentId);
  if (payment.status !== "PENDING") return settledState(payment, reader);

  const provider = getProviderForPayment(payment.processorType);
  assertCapability(provider, "terminal");
  let after;
  try {
    await provider.cancelTerminalCheckout!(payment.processorTxnId!, reader.readerId);
    after = await provider.getTerminalCheckout!(payment.processorTxnId!, reader.readerId);
  } catch (err) {
    throw processorRefusal(`${provider.displayName} couldn't cancel the card payment`, err);
  }
  if (after.status === "COMPLETED") return settleReaderPayment(paymentId);
  if (after.status === "PENDING") {
    return stateOf(
      payment,
      "WAITING",
      "The card is being authorized and can't be stopped now. It will finish in a moment.",
    );
  }
  try {
    const voided = await voidPendingPayment(paymentId, {
      voidedBy: actor,
      reason: "Card payment cancelled at the register",
    });
    return settledState(voided, reader);
  } catch (err) {
    // Completed or failed by another request in the meantime: say which.
    if (!(err instanceof VoidError)) throw err;
    const now = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    return now.status === "PENDING" ? settleReaderPayment(paymentId) : settledState(now, reader);
  }
}

/** Test mode: present a test card to the simulated reader holding this payment. */
export async function presentTestCard(paymentId: number): Promise<void> {
  const { payment, reader } = await loadReaderPayment(paymentId);
  if (payment.status !== "PENDING") {
    throw new ApiError(409, "This payment is no longer waiting for a card.");
  }
  const row = await prisma.cardReader.findUnique({
    where: { processorReaderId: reader.readerId },
  });
  if (!row || !isSimulatedReader(row)) {
    throw new ApiError(409, "Only a simulated reader can be given a test card.");
  }
  const provider = getProviderForPayment(payment.processorType);
  try {
    await provider.simulateCardPresented!(reader.readerId);
  } catch (err) {
    throw processorRefusal(`${provider.displayName} didn't present the test card`, err);
  }
}
