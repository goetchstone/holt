// /app/src/lib/ar.ts
//
// DB-backed Accounts Receivable. Loads a customer's ISSUED/PAID invoices +
// payments + open-item applications and computes their position / aging /
// reconciliation via the pure, proven arEngine. The MATH lives in arEngine; this
// file only maps the schema to it. Deposits-as-liability (AR slice 2) is not yet
// wired -- unapplied payments are treated as on-account credit for now.
// See docs/domains/accounts-receivable.md.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  invoiceOpenBalance,
  paymentUnapplied,
  customerPosition,
  agingBuckets,
  reconcileCustomerAr,
  type CustomerPosition,
  type AgingBuckets,
  type ReconResult,
} from "@/lib/arEngine";

const ZERO = new Prisma.Decimal(0);

function sumApplied(applications: { amountApplied: Prisma.Decimal }[]): Prisma.Decimal {
  return applications.reduce<Prisma.Decimal>((acc, a) => acc.plus(a.amountApplied), ZERO);
}

// Only ISSUED + PAID invoices are AR: DRAFT isn't recognized yet, VOID is excluded.
const AR_STATUSES: Prisma.EnumInvoiceStatusFilter["in"] = ["ISSUED", "PAID"];

async function loadCustomerArData(customerId: number) {
  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { customerId, status: { in: AR_STATUSES } },
      select: {
        id: true,
        total: true,
        dueDate: true,
        applications: { select: { amountApplied: true } },
      },
    }),
    prisma.payment.findMany({
      where: { customerId },
      select: { id: true, paymentAmount: true, applications: { select: { amountApplied: true } } },
    }),
  ]);
  return { invoices, payments };
}

export interface CustomerArSummary {
  position: CustomerPosition;
  aging: AgingBuckets;
}

export async function getCustomerArPosition(
  customerId: number,
  asOf: Date = new Date(),
): Promise<CustomerArSummary> {
  const { invoices, payments } = await loadCustomerArData(customerId);

  const invoiceOpens = invoices.map((inv) =>
    invoiceOpenBalance(inv.total ?? ZERO, sumApplied(inv.applications)),
  );
  const onAccount = payments.map((p) =>
    paymentUnapplied(p.paymentAmount, sumApplied(p.applications)),
  );

  const position = customerPosition({
    invoiceOpenBalances: invoiceOpens,
    onAccountCredits: onAccount,
    unearnedDeposits: [], // AR slice 2
  });

  const aging = agingBuckets(
    invoices.map((inv) => ({
      open: invoiceOpenBalance(inv.total ?? ZERO, sumApplied(inv.applications)),
      dueDate: inv.dueDate ?? asOf,
    })),
    asOf,
  );

  return { position, aging };
}

export async function reconcileCustomer(customerId: number): Promise<ReconResult> {
  const { invoices, payments } = await loadCustomerArData(customerId);
  return reconcileCustomerAr({
    invoices: invoices.map((inv) => ({
      id: inv.id,
      total: inv.total ?? ZERO,
      applied: sumApplied(inv.applications),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.paymentAmount,
      applied: sumApplied(p.applications),
    })),
    deposits: [],
  });
}
