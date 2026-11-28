// /app/__tests__/integration/customerLedgerLocking.integration.test.ts
//
// Two writers on one customer's ledger at once, on the real database.
//
// A ledger write reads Customer.openArBalance, writes rows that carry it
// forward, and stores the new balance. Nothing held the customer between the
// read and the write: two payments at the same moment left the stored balance
// short by one of them, two backfills each wrote the whole history, and a
// payment landing during a backfill was overwritten by the backfill's total.
// A second connection holds the customer's row here, so the two writers can
// be lined up one behind the other on purpose.
//
// Also here, because they are about what the backfill writes when it is not
// alone: a customer who already has a ledger entry from before the backfill.

import { type Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { appendEntry } from "@/lib/customerLedger";
import { backfillAllCustomers, backfillCustomerLedger } from "@/lib/customerLedgerBackfill";

/** A customer with one $1,000 order and a $400 payment on it: owes $600. */
async function customerOwing600() {
  const customer = await prisma.customer.create({ data: { firstName: "Dana", lastName: "Reed" } });
  const created = new Date("2026-10-01T10:00:00Z");
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "LEDGER-01",
      status: "ORDER",
      customerId: customer.id,
      created,
      orderDate: created,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            partNo: "ITEM-1",
            netPrice: 1000,
            cost: 0,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
      payments: {
        create: [
          {
            paymentAmount: 400,
            status: "COMPLETED",
            paymentType: "card",
            paymentDate: created,
            created: new Date("2026-10-01T10:05:00Z"),
          },
        ],
      },
    },
    select: { id: true },
  });
  return { customerId: customer.id, orderId: order.id };
}

/** What the customer's row says is owed, and what their ledger rows add up to. */
async function balances(customerId: number) {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { openArBalance: true },
  });
  const entries = await prisma.customerLedgerEntry.findMany({
    where: { customerId },
    orderBy: { id: "asc" },
  });
  const sum = entries.reduce((total, e) => total + Number(e.amount), 0);
  return { stored: Number(customer.openArBalance), sum: Math.round(sum * 100) / 100, entries };
}

/** A second connection, to hold a row while the code under test waits on it. */
function secondConnection() {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
  });
}

/** Until `n` sessions other than this one are waiting on a lock. */
async function untilSessionsWait(tx: Prisma.TransactionClient, n: number) {
  for (let i = 0; i < 200; i++) {
    // Activity is read once per transaction unless the snapshot is cleared.
    await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text AS cleared`;
    const [{ waiting }] = await tx.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fewer than ${n} session(s) ever waited on the customer's row.`);
}

/**
 * Run `first`, then `second`, each started while another connection holds the
 * customer's row, so both are waiting on it before either can finish.
 */
async function linedUpBehindTheCustomer(
  customerId: number,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
) {
  const holder = secondConnection();
  let a: Promise<unknown> | undefined;
  let b: Promise<unknown> | undefined;
  try {
    await holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`;
        a = first();
        a.catch(() => undefined); // surfaced by the await below
        await untilSessionsWait(tx, 1);
        b = second();
        b.catch(() => undefined);
        await untilSessionsWait(tx, 2);
      },
      { maxWait: 10000, timeout: 30000 },
    );
  } finally {
    await holder.$disconnect();
  }
  await a;
  await b;
}

describe("two writers on one customer's ledger (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("two payments at the same moment both reach the stored balance", async () => {
    const { customerId, orderId } = await customerOwing600();
    const pay = (amount: number, reference: string) => () =>
      appendEntry({
        customerId,
        type: "PAYMENT",
        amount: -amount,
        salesOrderId: orderId,
        reference,
        createdBy: "cashier@example.com",
      });

    await linedUpBehindTheCustomer(customerId, pay(100, "first"), pay(250, "second"));

    const { stored, sum, entries } = await balances(customerId);
    // Each read the balance as 0; the second to write stored -250, and the
    // first payment was gone from what the customer owes.
    expect(stored).toBe(-350);
    expect(sum).toBe(-350);
    // One chain: the second starts where the first ended.
    expect(Number(entries[1].balanceBefore)).toBe(Number(entries[0].balanceAfter));
  });

  it("a payment landing during a backfill is not written over by the backfill's total", async () => {
    const { customerId, orderId } = await customerOwing600();

    await linedUpBehindTheCustomer(
      customerId,
      () => backfillCustomerLedger(customerId),
      () =>
        appendEntry({
          customerId,
          type: "PAYMENT",
          amount: -100,
          salesOrderId: orderId,
          reference: "at the register",
          createdBy: "cashier@example.com",
        }),
    );

    const { stored, sum } = await balances(customerId);
    // The history says 600 owed and the new payment takes 100 off. The payment
    // had read the balance as 0 and stored -100 over the backfill's 600.
    expect(sum).toBe(500);
    expect(stored).toBe(500);
  });

  it("two backfills of one customer at once write the history once", async () => {
    const { customerId } = await customerOwing600();

    const [a, b] = await Promise.all([
      backfillCustomerLedger(customerId),
      backfillCustomerLedger(customerId),
    ]);

    // Each counted no entries and each wrote the SALE and the PAYMENT.
    expect([a.status, b.status].sort()).toEqual(["backfilled", "skipped-already-backfilled"]);
    const { stored, sum, entries } = await balances(customerId);
    expect(entries.map((e) => [e.type, Number(e.amount)])).toEqual([
      ["SALE", 1000],
      ["PAYMENT", -400],
    ]);
    expect(stored).toBe(600);
    expect(sum).toBe(600);
  });
});

describe("a customer who already has a ledger entry when the backfill runs (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("is handed back for review with the real gap, and nothing is written", async () => {
    const { customerId, orderId } = await customerOwing600();
    // Staff took $100 at the register before anyone ran the backfill.
    await appendEntry({
      customerId,
      type: "PAYMENT",
      amount: -100,
      salesOrderId: orderId,
      reference: "at the register",
      createdBy: "cashier@example.com",
    });

    const result = await backfillCustomerLedger(customerId);

    // "Any entry exists" skipped them as already done, diff 0: the $1,000 sale
    // and the $400 payment were never ledgered, and nothing said so.
    expect(result.status).toBe("needs-review-forward-entries");
    expect(result.entriesCreated).toBe(0);
    // Stored: -100 (the one entry). The order and its payment say 600.
    expect(result.validation).toMatchObject({
      ok: false,
      ledgerBalance: -100,
      sourceBalance: 600,
      diff: -700,
    });
    expect(await prisma.customerLedgerEntry.count({ where: { customerId } })).toBe(1);

    const run = await backfillAllCustomers({ customerIds: [customerId] });
    expect(run).toMatchObject({
      customersNeedingReview: 1,
      customersSkipped: 0,
      customersBackfilled: 0,
      entriesCreated: 0,
    });
    expect(run.driftedCustomers).toEqual([
      { customerId, ledgerBalance: -100, sourceBalance: 600, diff: -700 },
    ]);
  });

  it("is still skipped as done once the backfill's own rows are there", async () => {
    const { customerId } = await customerOwing600();
    expect((await backfillCustomerLedger(customerId)).status).toBe("backfilled");
    expect((await backfillCustomerLedger(customerId)).status).toBe("skipped-already-backfilled");
    expect(await prisma.customerLedgerEntry.count({ where: { customerId } })).toBe(2);
  });

  it("ledgers neither an unpaid payment link nor a quote", async () => {
    const { customerId } = await customerOwing600();
    const created = new Date("2026-10-02T10:00:00Z");
    await prisma.salesOrder.create({
      data: {
        orderno: "LEDGER-QUOTE",
        status: "QUOTE",
        customerId,
        created,
        orderDate: created,
        lineItems: {
          create: [
            { lineNumber: 1, partNo: "ITEM-2", netPrice: 2000, cost: 0, orderedQuantity: 1 },
          ],
        },
        payments: {
          create: [
            {
              paymentAmount: 2000,
              status: "PENDING",
              paymentType: "card",
              paymentDate: created,
              created,
            },
          ],
        },
      },
    });

    const result = await backfillCustomerLedger(customerId);

    // The quote was $2,000 owed and the unpaid link $2,000 received.
    expect(result.status).toBe("backfilled");
    expect(result.finalBalance).toBe(600);
    const { stored, entries } = await balances(customerId);
    expect(stored).toBe(600);
    expect(entries.map((e) => e.type)).toEqual(["SALE", "PAYMENT"]);
  });
});
