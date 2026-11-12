// /app/src/lib/giftCardLedger.ts
//
// The one way a gift card's balance changes. Owner, 2026-11-11: "everything must be transactional,
// be on a ledger", and "if we can void something and the money disappears, that is not good
// accounting practice". So a balance moves only when money moves, each change is written in the
// caller's transaction together with its GiftCardTransaction row, and the row's `amount` is the
// signed change (negative when value leaves the card), so balanceBefore + amount = balanceAfter.
//
// Every change is a single conditional UPDATE: Postgres locks the card's row and re-checks the
// condition, so two spends of one balance can't both pass, and a closed card is never touched.
// There's no Void and no Adjust; a card is retired by moving its balance to a new one
// (replaceCard), which leaves it REPLACED at $0 with its history. A card comes into being only
// with money too: issueCard, when the sale it's sold on is paid in full.

import type { GiftCardStatus, GiftCardTransactionType, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export class GiftCardError extends Error {}

/** A card that can still take and give value. VOIDED (from before Void was removed) and REPLACED can't. */
const OPEN_STATUSES: GiftCardStatus[] = ["ACTIVE", "REDEEMED"];

export function isClosedCard(status: string): boolean {
  return status === "VOIDED" || status === "REPLACED";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A positive amount in cents, from a number or a numeric string; anything else is refused. */
export function parseCardAmount(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new GiftCardError("Amount must be a number");
  }
  const amount = round2(n);
  if (amount <= 0) throw new GiftCardError("Amount must be greater than zero");
  return amount;
}

function closedMessage(status: string): string {
  return status === "REPLACED"
    ? "This gift card's balance moved to a new card, so it can't be used."
    : "This gift card was voided, so it can't be used.";
}

async function explainRefusal(tx: Tx, cardId: number, amount: number): Promise<never> {
  const card = await tx.giftCard.findUnique({
    where: { id: cardId },
    select: { status: true, currentBalance: true },
  });
  if (!card) throw new GiftCardError("Gift card not found");
  if (isClosedCard(card.status)) throw new GiftCardError(closedMessage(card.status));
  const balance = Number(card.currentBalance);
  throw new GiftCardError(
    `Insufficient gift card balance: available $${balance.toFixed(2)}, requested $${amount.toFixed(2)}`,
  );
}

async function recordChange(
  tx: Tx,
  input: {
    cardId: number;
    type: GiftCardTransactionType;
    amount: number;
    reference?: string | null;
    notes?: string | null;
    createdBy: string | null;
  },
): Promise<{ balanceBefore: number; balanceAfter: number }> {
  const card = await tx.giftCard.findUniqueOrThrow({
    where: { id: input.cardId },
    select: { currentBalance: true },
  });
  const balanceAfter = round2(Number(card.currentBalance));
  const balanceBefore = round2(balanceAfter - input.amount);
  await tx.giftCardTransaction.create({
    data: {
      giftCardId: input.cardId,
      transactionType: input.type,
      amount: input.amount,
      balanceBefore,
      balanceAfter,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    },
  });
  return { balanceBefore, balanceAfter };
}

/**
 * Take a payment off a card. Refuses a closed card and anything over the balance; a card spent
 * to $0 is REDEEMED (it can be reloaded and used again).
 */
export async function spendFromCard(
  tx: Tx,
  input: { cardId: number; amount: number; createdBy: string | null; reference?: string | null },
): Promise<{ balanceBefore: number; balanceAfter: number }> {
  const amount = parseCardAmount(input.amount);
  const moved = await tx.giftCard.updateMany({
    where: { id: input.cardId, status: { in: OPEN_STATUSES }, currentBalance: { gte: amount } },
    data: { currentBalance: { decrement: amount }, updatedBy: input.createdBy },
  });
  if (moved.count === 0) return explainRefusal(tx, input.cardId, amount);
  const change = await recordChange(tx, {
    cardId: input.cardId,
    type: "REDEMPTION",
    amount: -amount,
    reference: input.reference,
    createdBy: input.createdBy,
  });
  if (change.balanceAfter === 0) {
    await tx.giftCard.update({ where: { id: input.cardId }, data: { status: "REDEEMED" } });
  }
  return change;
}

/**
 * Put value on a card: a refund of a payment made with it, or a reload paid for on a sale. A
 * REDEEMED card becomes ACTIVE again; a closed card is refused, so value can't reach a card that
 * was retired.
 */
export async function creditToCard(
  tx: Tx,
  input: {
    cardId: number;
    amount: number;
    type: "REFUND" | "RELOAD";
    createdBy: string | null;
    reference?: string | null;
    notes?: string | null;
  },
): Promise<{ balanceBefore: number; balanceAfter: number }> {
  const amount = parseCardAmount(input.amount);
  const moved = await tx.giftCard.updateMany({
    where: { id: input.cardId, status: { in: OPEN_STATUSES } },
    data: {
      currentBalance: { increment: amount },
      status: "ACTIVE",
      updatedBy: input.createdBy,
    },
  });
  if (moved.count === 0) return explainRefusal(tx, input.cardId, amount);
  return recordChange(tx, {
    cardId: input.cardId,
    type: input.type,
    amount,
    reference: input.reference,
    notes: input.notes,
    createdBy: input.createdBy,
  });
}

/**
 * Issue a new card with its first value: a card sold on a sale, issued with the payment that pays
 * the sale off (lib/sales/giftCardLines.ts). ACTIVE, with an ISSUANCE row from $0. A number
 * already in use is refused; a reload of an open card is creditToCard with type RELOAD.
 */
export async function issueCard(
  tx: Tx,
  input: { barcode: string; amount: number; createdBy: string | null; reference?: string | null },
): Promise<{ cardId: number; balanceBefore: number; balanceAfter: number }> {
  const barcode = input.barcode.trim();
  if (!barcode) throw new GiftCardError("Scan or type the card's number");
  const amount = parseCardAmount(input.amount);
  const taken = await tx.giftCard.findUnique({ where: { barcode }, select: { id: true } });
  if (taken) throw new GiftCardError("That card number is already in use");

  const card = await tx.giftCard.create({
    data: {
      barcode,
      initialAmount: amount,
      currentBalance: amount,
      status: "ACTIVE",
      activatedAt: new Date(),
      createdBy: input.createdBy,
    },
  });
  await tx.giftCardTransaction.create({
    data: {
      giftCardId: card.id,
      transactionType: "ISSUANCE",
      amount,
      balanceBefore: 0,
      balanceAfter: amount,
      reference: input.reference ?? null,
      createdBy: input.createdBy,
    },
  });
  return { cardId: card.id, balanceBefore: 0, balanceAfter: amount };
}

/**
 * Retire a card by moving its whole balance to a new card (owner: "issuing a new one using the
 * old one to pay for the new one"). The old card ends REPLACED at $0, linked to the new one, and
 * both keep their history. The new card's number must not be in use.
 */
export async function replaceCard(
  tx: Tx,
  input: { cardId: number; newBarcode: string; createdBy: string | null },
): Promise<{ newCardId: number; moved: number }> {
  const barcode = input.newBarcode.trim();
  if (!barcode) throw new GiftCardError("Scan or type the new card's number");
  // Lock the old card for the whole move: nothing else can spend it meanwhile.
  const rows = await tx.$queryRaw<Array<{ status: string; currentBalance: unknown }>>`
    SELECT status, "currentBalance" FROM "GiftCard" WHERE id = ${input.cardId} FOR UPDATE`;
  const old = rows[0];
  if (!old) throw new GiftCardError("Gift card not found");
  if (isClosedCard(old.status)) throw new GiftCardError(closedMessage(old.status));
  const taken = await tx.giftCard.findUnique({ where: { barcode }, select: { id: true } });
  if (taken) throw new GiftCardError("That card number is already in use");

  const moved = round2(Number(old.currentBalance));
  const fresh = await tx.giftCard.create({
    data: {
      barcode,
      initialAmount: moved,
      currentBalance: moved,
      status: moved > 0 ? "ACTIVE" : "REDEEMED",
      activatedAt: new Date(),
      notes: `Replaces card #${input.cardId}`,
      createdBy: input.createdBy,
    },
  });
  await tx.giftCard.update({
    where: { id: input.cardId },
    data: {
      currentBalance: 0,
      status: "REPLACED",
      replacedById: fresh.id,
      updatedBy: input.createdBy,
    },
  });
  await tx.giftCardTransaction.createMany({
    data: [
      {
        giftCardId: input.cardId,
        transactionType: "TRANSFER",
        amount: -moved,
        balanceBefore: moved,
        balanceAfter: 0,
        reference: `To card #${fresh.id}`,
        createdBy: input.createdBy,
      },
      {
        giftCardId: fresh.id,
        transactionType: "TRANSFER",
        amount: moved,
        balanceBefore: 0,
        balanceAfter: moved,
        reference: `From card #${input.cardId}`,
        createdBy: input.createdBy,
      },
    ],
  });
  return { newCardId: fresh.id, moved };
}
