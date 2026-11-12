// /app/src/lib/sales/giftCardLines.ts
//
// A gift card sold or reloaded as a line on a sale (owner, 2026-11-11). The card's value is a
// liability the store holds, not sales revenue, and "the card goes live when the sale is paid in
// full". So a card line is written with the sale (create-from-cart, checked here first) and the
// card is issued, or reloaded, only by issuePaidGiftCards: inside the transaction of the payment
// that pays the sale off, so the money and the card's balance move together or not at all.
//
// Every path that completes a payment on an order calls issuePaidGiftCards (rule 42):
// recordPaymentTx (the register, the order screen's store credit, a return's credit applied to
// what the original still owes) and completePayment (a processor's webhook). See pos.md.
//
// Taking a live card back is the store's call (AppSettings.giftCardsRefundable, off by default;
// owner: "Most places will not refund a giftcard ... this should be a config and then only if
// unused"). giftCardLineChangeProblem is the one gate, and takeBackCardLine moves the value off
// the card in the transaction of the money that goes back: a whole-sale cancel, cancelling the
// line, or booking its return.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeBalance, round2 } from "@/lib/paymentService";
import { COUNTED_LINE_FILTER, isCountedLine } from "@/lib/salesOrderRevenue";
import {
  creditToCard,
  GiftCardError,
  isClosedCard,
  issueCard,
  parseCardAmount,
  takeBackFromCard,
} from "@/lib/giftCardLedger";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { getAppSettings } from "@/lib/appSettings";
import {
  GIFT_CARD_LINE_NAME,
  closedCardMessage,
  type GiftCardCartLine,
} from "./giftCardLineShared";

type Tx = Prisma.TransactionClient;

/** A card line that passed checkGiftCardLines: what create-from-cart writes. */
export interface CheckedGiftCardLine {
  giftCardNumber: string;
  amount: number;
  /** "Gift card", or "Gift card reload" when the number is an open card already. */
  productName: string;
}

/**
 * The cart's card lines checked before anything is written, or why they can't be sold: each has a
 * number and an amount in whole cents above zero, no number twice, and none a card that was
 * retired (REPLACED, or VOIDED before Void was removed). A number that's an open card is a reload.
 */
export async function checkGiftCardLines(
  lines: GiftCardCartLine[],
): Promise<{ error: string } | { lines: CheckedGiftCardLine[] }> {
  if (lines.length === 0) return { lines: [] };
  if (!(await isModuleEnabled("giftCards"))) {
    return { error: "Gift cards are switched off for this store (Settings, Modules)." };
  }

  const wanted = readCardLines(lines);
  if ("error" in wanted) return wanted;

  const cards = await prisma.giftCard.findMany({
    where: { barcode: { in: wanted.lines.map((w) => w.giftCardNumber) } },
    select: { barcode: true, status: true, replacedById: true },
  });
  const byNumber = new Map(cards.map((c) => [c.barcode, c]));
  const checked: CheckedGiftCardLine[] = [];
  for (const w of wanted.lines) {
    const card = byNumber.get(w.giftCardNumber);
    const closed = card ? closedCardMessage(card) : null;
    if (closed) return { error: `Gift card ${w.giftCardNumber}: ${closed}` };
    checked.push({
      ...w,
      productName: card ? GIFT_CARD_LINE_NAME.RELOAD : GIFT_CARD_LINE_NAME.NEW,
    });
  }
  return { lines: checked };
}

/** Each line's number and amount as sent, or why one can't be sold: no number, or the same twice. */
function readCardLines(
  lines: GiftCardCartLine[],
): { error: string } | { lines: { giftCardNumber: string; amount: number }[] } {
  const read: { giftCardNumber: string; amount: number }[] = [];
  for (const line of lines) {
    const giftCardNumber =
      typeof line.giftCardNumber === "string" ? line.giftCardNumber.trim() : "";
    if (!giftCardNumber) return { error: "Scan or type the gift card's number." };
    if (read.some((r) => r.giftCardNumber === giftCardNumber)) {
      return { error: `Gift card ${giftCardNumber} is on this sale twice.` };
    }
    const amount = cardLineAmount(line.amount);
    if (typeof amount === "string") return { error: `Gift card ${giftCardNumber}: ${amount}` };
    read.push({ giftCardNumber, amount });
  }
  return { lines: read };
}

/** The amount a card line puts on its card, or why it can't: above zero, in whole cents. */
function cardLineAmount(value: unknown): number | string {
  let amount: number;
  try {
    amount = parseCardAmount(value);
  } catch (err) {
    return err instanceof GiftCardError ? err.message : "Amount must be a number";
  }
  // parseCardAmount rounds to the cent; a line asking for a fraction of one is refused rather
  // than rounded, so the card holds exactly what the sale charged.
  if (Math.abs(amount - Number(value)) > 1e-9) return "Amount must be in whole cents";
  return amount;
}

/** Where a store turns refunding cards on, named in every refusal it causes. */
const REFUND_SETTING = 'Settings, "Refund unused gift cards"';

/**
 * Why a card line can't take this change, or null (a line that isn't a card, or a change that's
 * fine). A card line is a card's number and the money paid for it, so its price, quantity and
 * product don't change, or the card would hold what nobody paid for: it's cancelled (or taken off
 * a quote) and sold again at the register. Once its card is issued it can be cancelled or
 * returned only where the store refunds cards, and only while the card is unused
 * (liveCardRefundProblem). A note can always go on. `action` is the line route's (`cancel`,
 * `update`, `note`...), or `remove` for taking it off a quote, or `return`. The line route, a
 * whole-sale cancel, a new return and takeBackCardLine all ask (rule 42).
 */
export async function giftCardLineChangeProblem(
  db: Tx | typeof prisma,
  line: { id: number; giftCardNumber: string | null; giftCardId: number | null },
  action: string,
): Promise<string | null> {
  if (!line.giftCardNumber || action === "note") return null;
  if (line.giftCardId != null) {
    if (action === "cancel" || action === "return") {
      return liveCardRefundProblem(db, line.id, action);
    }
    return `Gift card ${line.giftCardNumber} is live, so its line can't be changed. Cancel or return it instead.`;
  }
  if (action === "cancel" || action === "remove") return null;
  return "A gift card line is the card's number and amount, so it can't be changed. Cancel it and sell the card again at the register.";
}

/**
 * Why a live card's line can't be cancelled or returned, or null. The store has to refund cards,
 * and the card has to be unused: it still holds the line's whole amount and nothing has left it
 * since this line issued or reloaded it. A return is for a sale that was invoiced, as with goods;
 * before that the line is cancelled, and its money goes back from the deposit it sits in.
 */
async function liveCardRefundProblem(
  db: Tx | typeof prisma,
  lineItemId: number,
  action: "cancel" | "return",
): Promise<string | null> {
  const line = await db.orderLineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    select: {
      giftCardNumber: true,
      giftCardId: true,
      netPrice: true,
      salesOrder: {
        select: { invoices: { where: { status: { not: "VOID" } }, select: { id: true }, take: 1 } },
      },
      giftCardTransactions: {
        select: { id: true, transactionType: true, amount: true },
        orderBy: { id: "asc" },
      },
    },
  });
  const number = line.giftCardNumber;
  const cardId = line.giftCardId;
  if (cardId == null) return null;
  if (!(await getAppSettings()).giftCardsRefundable) {
    return `Gift card ${number} is live, and this store doesn't refund gift cards (${REFUND_SETTING}).`;
  }
  // Its value already came off the card: a cancel that refunded and then didn't finish. Cancelling
  // again finishes it; a return would pay it back a second time.
  if (line.giftCardTransactions.some((t) => Number(t.amount) < 0)) {
    return action === "cancel"
      ? null
      : `Gift card ${number}'s value has already come back off the card. Cancel its line to finish.`;
  }
  if (action === "return" && line.salesOrder.invoices.length === 0) {
    return `Gift card ${number}'s sale hasn't been invoiced, so cancel its line instead of returning it.`;
  }
  const issued = line.giftCardTransactions.find(
    (t) => t.transactionType === "ISSUANCE" || t.transactionType === "RELOAD",
  );
  const card = await db.giftCard.findUniqueOrThrow({
    where: { id: cardId },
    select: { status: true, currentBalance: true },
  });
  const spentSince = issued
    ? await db.giftCardTransaction.count({
        where: { giftCardId: cardId, id: { gt: issued.id }, amount: { lt: 0 } },
      })
    : 0;
  if (
    !issued ||
    spentSince > 0 ||
    isClosedCard(card.status) ||
    Number(card.currentBalance) < Number(line.netPrice)
  ) {
    return `Gift card ${number} has been used since it was sold, so it can't be refunded.`;
  }
  return null;
}

/** giftCardLineChangeProblem for a line by its id; null for a line that isn't there. */
export async function giftCardLineEditProblem(
  db: Tx | typeof prisma,
  lineItemId: number,
  action: string,
): Promise<string | null> {
  const line = await db.orderLineItem.findUnique({
    where: { id: lineItemId },
    select: { id: true, giftCardNumber: true, giftCardId: true },
  });
  return line ? giftCardLineChangeProblem(db, line, action) : null;
}

/**
 * Take a live card line's value back off its card, in the caller's transaction: the one that
 * returns its money (a refund's, or the credit's, or the cancel's or return's own). Returns why it
 * can't (the gate's answer, for the caller to throw as its own error), or null once the value is
 * off the card. Nothing for a line that isn't a live card, and nothing the second time: the line
 * and its card are locked, so of two at once the second sees the first's REFUND row.
 */
export async function takeBackCardLine(
  tx: Tx,
  lineItemId: number,
  actor: string | null,
  opts: { action: "cancel" | "return"; reference?: string; at?: Date },
): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM "OrderLineItem" WHERE id = ${lineItemId} FOR UPDATE`;
  const line = await tx.orderLineItem.findUnique({
    where: { id: lineItemId },
    select: {
      id: true,
      giftCardNumber: true,
      giftCardId: true,
      netPrice: true,
      salesOrder: { select: { id: true, orderno: true } },
      giftCardTransactions: { where: { amount: { lt: 0 } }, select: { id: true } },
    },
  });
  if (!line?.giftCardNumber || line.giftCardId == null) return null;
  if (opts.action === "cancel" && line.giftCardTransactions.length > 0) return null;
  await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${line.giftCardId} FOR UPDATE`;
  const problem = await giftCardLineChangeProblem(tx, line, opts.action);
  if (problem) return problem;
  const order = line.salesOrder;
  await takeBackFromCard(tx, {
    cardId: line.giftCardId,
    amount: Number(line.netPrice),
    orderLineItemId: line.id,
    createdBy: actor,
    reference: opts.reference ?? (order.orderno ? `Order ${order.orderno}` : `Order #${order.id}`),
    at: opts.at,
  });
  return null;
}

/**
 * Issue the order's card lines once the order is paid in full, in the caller's transaction (the
 * payment's). Each waiting line (a counted line with a number and no card yet) is issued through
 * the card ledger: a number that's an open card gets a RELOAD of the line's amount, any other a
 * new card (issueCard); a retired card is refused, which refuses the payment with it. The line
 * then carries the card, so it's issued once. Before the order is paid in full, nothing happens.
 *
 * "Paid in full" is what the order owes less what was paid, from computeBalance, with no
 * tolerance: its balanceDue treats up to $1.00 owed as paid, and a card is never issued short.
 */
export async function issuePaidGiftCards(
  tx: Tx,
  orderId: number,
  actor: string | null,
): Promise<void> {
  // Nothing to do, and no lock taken, on a sale without a card waiting: almost every sale.
  const waiting = await tx.orderLineItem.count({
    where: {
      salesOrderId: orderId,
      lineItemStatus: COUNTED_LINE_FILTER,
      giftCardNumber: { not: null },
      giftCardId: null,
    },
  });
  if (waiting === 0) return;

  // Two payments landing together decide one after the other: the second waits here, then reads
  // the first's payment and the cards it issued. NO KEY UPDATE, so it doesn't wait on the
  // foreign-key share lock a payment row takes on its order.
  await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${orderId} FOR NO KEY UPDATE`;
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      orderno: true,
      lineItems: {
        select: {
          id: true,
          netPrice: true,
          orderedQuantity: true,
          vatAmount: true,
          lineItemStatus: true,
          giftCardNumber: true,
          giftCardId: true,
        },
        orderBy: { lineNumber: "asc" },
      },
      payments: { select: { paymentAmount: true, status: true, isRefund: true } },
    },
  });
  const { totalDue, totalPaid } = computeBalance(order.lineItems, order.payments);
  if (round2(totalDue - totalPaid) > 0) return;

  const reference = order.orderno ? `Order ${order.orderno}` : `Order #${orderId}`;
  for (const line of order.lineItems) {
    if (!line.giftCardNumber || line.giftCardId != null) continue;
    if (!isCountedLine(line.lineItemStatus)) continue;
    const amount = Number(line.netPrice);
    const existing = await tx.giftCard.findUnique({
      where: { barcode: line.giftCardNumber },
      select: { id: true },
    });
    let cardId: number;
    if (existing) {
      await creditToCard(tx, {
        cardId: existing.id,
        amount,
        type: "RELOAD",
        createdBy: actor,
        reference,
        orderLineItemId: line.id,
      });
      cardId = existing.id;
    } else {
      ({ cardId } = await issueCard(tx, {
        barcode: line.giftCardNumber,
        amount,
        createdBy: actor,
        reference,
        orderLineItemId: line.id,
      }));
    }
    await tx.orderLineItem.update({ where: { id: line.id }, data: { giftCardId: cardId } });
  }
}
