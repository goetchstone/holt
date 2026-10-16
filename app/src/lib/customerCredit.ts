// /app/src/lib/customerCredit.ts
//
// Store credit: a customer's money held on account, issued by a refund and
// spent toward a new sale or a rewrite. Every movement is one row in
// CustomerCreditTransaction and a change to Customer.creditBalance, written
// by the functions here and nowhere else (rule 42), each one:
//
//   - in the caller's transaction, so the credit moves with the payment or
//     refund that caused it, or not at all;
//   - holding the customer's credit lock, so two spends of the same balance
//     cannot both pass the check (the database's
//     Customer_creditBalance_nonnegative CHECK is the floor under it);
//   - and, for a spend, only on the customer's own order: credit is never
//     spent on someone else's sale or on an order with no customer.

import type { CustomerCreditTransaction, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roundMoney as round2 } from "@/lib/money";

type Tx = Prisma.TransactionClient;

/** Advisory-lock key space for store credit; see STOCK_LOCK_SPACE in inventory/ledger.ts. */
const CREDIT_LOCK_SPACE = 5_461_069;

export class StoreCreditError extends Error {}

export async function getBalance(customerId: number): Promise<number> {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { creditBalance: true },
  });
  return Number(customer.creditBalance);
}

interface Movement {
  customerId: number;
  type: "REFUND_CREDIT" | "USAGE" | "ADJUSTMENT";
  /** Signed: positive adds credit, negative spends it. */
  amount: number;
  paymentId?: number | null;
  salesOrderId?: number | null;
  reference?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

async function moveCredit(tx: Tx, m: Movement): Promise<CustomerCreditTransaction> {
  const amount = round2(m.amount);
  if (amount === 0 || !Number.isFinite(amount)) {
    throw new StoreCreditError("A store credit movement must be a nonzero amount.");
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CREDIT_LOCK_SPACE}::int, ${m.customerId}::int)`;
  const customer = await tx.customer.findUniqueOrThrow({
    where: { id: m.customerId },
    select: { creditBalance: true },
  });
  const balanceBefore = round2(Number(customer.creditBalance));
  const balanceAfter = round2(balanceBefore + amount);
  if (balanceAfter < 0) {
    throw new StoreCreditError(
      `Insufficient store credit: available $${balanceBefore.toFixed(2)}, requested $${Math.abs(amount).toFixed(2)}`,
    );
  }
  const txn = await tx.customerCreditTransaction.create({
    data: {
      customerId: m.customerId,
      type: m.type,
      amount,
      balanceBefore,
      balanceAfter,
      paymentId: m.paymentId ?? undefined,
      salesOrderId: m.salesOrderId ?? undefined,
      reference: m.reference ?? undefined,
      notes: m.notes ?? undefined,
      createdBy: m.createdBy ?? undefined,
    },
  });
  await tx.customer.update({
    where: { id: m.customerId },
    data: { creditBalance: balanceAfter },
  });
  return txn;
}

/** Put `amount` on the customer's account, for the refund row `paymentId`. */
export function issueStoreCredit(
  tx: Tx,
  input: {
    customerId: number;
    amount: number;
    paymentId: number;
    salesOrderId?: number | null;
    notes?: string | null;
    createdBy?: string | null;
  },
): Promise<CustomerCreditTransaction> {
  if (!(input.amount > 0)) throw new StoreCreditError("Store credit issued must be positive.");
  return moveCredit(tx, { ...input, type: "REFUND_CREDIT" });
}

/**
 * Spend `amount` of the customer's credit on the payment row `paymentId` for
 * their own order `salesOrderId`. Refused when the order has no customer or
 * belongs to someone else.
 */
export async function spendStoreCredit(
  tx: Tx,
  input: {
    customerId: number;
    amount: number;
    paymentId: number;
    salesOrderId: number;
    createdBy?: string | null;
  },
): Promise<CustomerCreditTransaction> {
  if (!(input.amount > 0)) throw new StoreCreditError("Store credit spent must be positive.");
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: input.salesOrderId },
    select: { customerId: true, orderno: true },
  });
  if (order.customerId == null) {
    throw new StoreCreditError(
      "Store credit can only be spent on an order with a customer: add the customer to the order first.",
    );
  }
  if (order.customerId !== input.customerId) {
    throw new StoreCreditError("Store credit can only be spent on the same customer's order.");
  }
  return moveCredit(tx, {
    customerId: input.customerId,
    type: "USAGE",
    amount: -input.amount,
    paymentId: input.paymentId,
    salesOrderId: input.salesOrderId,
    reference: order.orderno,
    createdBy: input.createdBy,
  });
}

/** A manual correction by someone holding customer.credit.adjust. */
export async function adjustCredit(
  customerId: number,
  amount: number,
  opts: { reason?: string; createdBy?: string },
): Promise<CustomerCreditTransaction> {
  return prisma.$transaction((tx) =>
    moveCredit(tx, {
      customerId,
      type: "ADJUSTMENT",
      amount,
      notes: opts.reason,
      createdBy: opts.createdBy,
    }),
  );
}
