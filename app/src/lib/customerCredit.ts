// /app/src/lib/customerCredit.ts
import { prisma } from "@/lib/prisma";
import type { CustomerCreditTransaction } from "@prisma/client";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function getBalance(customerId: number): Promise<number> {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { creditBalance: true },
  });
  return Number(customer.creditBalance);
}

export async function issueCredit(
  customerId: number,
  amount: number,
  opts: {
    paymentId?: number;
    salesOrderId?: number;
    reason?: string;
    createdBy?: string;
  },
): Promise<CustomerCreditTransaction> {
  const rounded = round2(amount);
  if (rounded <= 0) {
    throw new Error("Credit amount must be positive");
  }

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { creditBalance: true },
    });
    const balanceBefore = Number(customer.creditBalance);
    const balanceAfter = round2(balanceBefore + rounded);

    const txn = await tx.customerCreditTransaction.create({
      data: {
        customerId,
        type: "REFUND_CREDIT",
        amount: rounded,
        balanceBefore,
        balanceAfter,
        paymentId: opts.paymentId,
        salesOrderId: opts.salesOrderId,
        notes: opts.reason,
        createdBy: opts.createdBy,
      },
    });

    await tx.customer.update({
      where: { id: customerId },
      data: { creditBalance: balanceAfter },
    });

    return txn;
  });
}

export async function applyCredit(
  customerId: number,
  amount: number,
  opts: {
    paymentId?: number;
    salesOrderId?: number;
    createdBy?: string;
  },
): Promise<CustomerCreditTransaction> {
  const rounded = round2(amount);
  if (rounded <= 0) {
    throw new Error("Credit amount must be positive");
  }

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { creditBalance: true },
    });
    const balanceBefore = Number(customer.creditBalance);

    if (balanceBefore < rounded) {
      throw new Error(
        `Insufficient store credit: available $${balanceBefore.toFixed(2)}, requested $${rounded.toFixed(2)}`,
      );
    }

    const balanceAfter = round2(balanceBefore - rounded);

    const txn = await tx.customerCreditTransaction.create({
      data: {
        customerId,
        type: "USAGE",
        amount: -rounded,
        balanceBefore,
        balanceAfter,
        paymentId: opts.paymentId,
        salesOrderId: opts.salesOrderId,
        createdBy: opts.createdBy,
      },
    });

    await tx.customer.update({
      where: { id: customerId },
      data: { creditBalance: balanceAfter },
    });

    return txn;
  });
}

export async function adjustCredit(
  customerId: number,
  amount: number,
  opts: {
    reason?: string;
    createdBy?: string;
  },
): Promise<CustomerCreditTransaction> {
  const rounded = round2(amount);
  if (rounded === 0) {
    throw new Error("Adjustment amount must be non-zero");
  }

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { creditBalance: true },
    });
    const balanceBefore = Number(customer.creditBalance);
    const balanceAfter = round2(balanceBefore + rounded);

    if (balanceAfter < 0) {
      throw new Error(`Adjustment would result in negative balance: $${balanceAfter.toFixed(2)}`);
    }

    const txn = await tx.customerCreditTransaction.create({
      data: {
        customerId,
        type: "ADJUSTMENT",
        amount: rounded,
        balanceBefore,
        balanceAfter,
        notes: opts.reason,
        createdBy: opts.createdBy,
      },
    });

    await tx.customer.update({
      where: { id: customerId },
      data: { creditBalance: balanceAfter },
    });

    return txn;
  });
}
