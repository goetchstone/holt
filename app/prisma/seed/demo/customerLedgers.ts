// /app/prisma/seed/demo/customerLedgers.ts
//
// Every customer's ledger, and what each owes on their account, built from the
// orders and payments the seed wrote.
//
// The ledger was left out of the demo until 2026-11-28 on purpose: writing it
// for payments alone would have left every customer looking owed money. It is
// built here the way a store builds it for the history it brings with it, with
// the backfill (lib/customerLedgerBackfill.ts): a SALE for each sale and return,
// a PAYMENT for each payment that is money in hand, in date order, with the
// customer's balance stored at the end. Quotes and unpaid payment links are not
// ledgered.
//
// It runs last, after every module that writes an order or a payment, and it
// stops the seed unless every customer's ledger agrees with their orders and
// payments. A customer handed back "for review" would mean some module wrote a
// ledger entry of its own before this ran; the seed writes none.
//
// What a seeded ledger does not show: the application does not yet post a SALE
// when a quote becomes an order (docs/domains/accounting.md, "Still missing").
// A sale rung after seeding therefore adds only its payments to the ledger.

import type { PrismaClient } from "@prisma/client";
import { backfillAllCustomers } from "@/lib/customerLedgerBackfill";

export interface CustomerLedgersResult {
  customersWithALedger: number;
  entriesCreated: number;
  customersOwing: number;
  totalOwed: number;
}

export async function seedCustomerLedgers(prisma: PrismaClient): Promise<CustomerLedgersResult> {
  const run = await backfillAllCustomers();

  const notRight =
    run.customersFailed + run.customersBackfilledWithDrift + run.customersNeedingReview;
  if (notRight > 0) {
    const first = [
      ...run.errors.map((e) => `customer ${e.customerId}: ${e.message}`),
      ...run.driftedCustomers.map(
        (d) =>
          `customer ${d.customerId}: ledger ${d.ledgerBalance}, orders and payments ${d.sourceBalance}`,
      ),
    ].slice(0, 5);
    throw new Error(
      `Demo seed: ${notRight} customer ledger(s) do not agree with their orders and payments ` +
        `(${run.customersFailed} failed, ${run.customersBackfilledWithDrift} off, ` +
        `${run.customersNeedingReview} with entries from before this ran).\n` +
        first.map((line) => `  - ${line}`).join("\n"),
    );
  }

  const owing = await prisma.customer.aggregate({
    where: { openArBalance: { gt: 0 } },
    _count: { _all: true },
    _sum: { openArBalance: true },
  });
  // Counted from the table: a customer with only a quote is "done" to the
  // backfill and has no ledger.
  const withEntries = await prisma.customerLedgerEntry.groupBy({ by: ["customerId"] });
  return {
    customersWithALedger: withEntries.length,
    entriesCreated: run.entriesCreated,
    customersOwing: owing._count._all,
    totalOwed: Number(owing._sum.openArBalance ?? 0),
  };
}
