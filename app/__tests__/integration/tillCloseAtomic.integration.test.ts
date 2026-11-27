// /app/__tests__/integration/tillCloseAtomic.integration.test.ts
//
// Closing a till against money being booked on it, on the real database.
//
// The close adds up what was booked against the till to say what cash the
// drawer should hold. That sum was taken before the close's transaction and
// nothing held the till while it ran, so a payment landing in between was left
// out (an overage that was not there), a payment or refund could land on a
// till already closed, and two closes at once both went through. Each case
// below lines the two sides up on purpose: a second connection holds the
// till's row, or stands in for the half that is already in flight.
//
// Real handlers, payment service and database; only the session is made up.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { type Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { processRefund, recordPayment, RefundError } from "@/lib/paymentService";
import { handleClose } from "@/pages/api/tills/[id]/close";
import { handleReconcile } from "@/pages/api/tills/[id]/reconcile";

function makeReq(tillId: number, body: unknown): NextApiRequest {
  return { method: "POST", query: { id: String(tillId) }, body } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    statusCode: 0 as number,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

const cashierSession = {
  user: { id: "cashier", email: "cashier@example.com" },
} as unknown as Session;

/** A register with an open till holding a $200 float, and an order owing $1,000. */
async function fixtures() {
  const store = await prisma.storeLocation.create({
    data: { name: "Main Street", code: "MS", type: "STORE" },
  });
  const register = await prisma.register.create({
    data: { name: "Front Desk", storeLocationId: store.id },
  });
  await prisma.user.create({ data: { id: "cashier", email: "cashier@example.com" } });
  const cashier = await prisma.staffMember.create({
    data: {
      userId: "cashier",
      displayName: "Cashier Cass",
      email: "cashier@example.com",
      role: "REGISTER",
    },
  });
  const till = await prisma.till.create({
    data: { registerId: register.id, status: "OPEN", openedById: cashier.id, openingCash: 200 },
  });
  const customer = await prisma.customer.create({ data: { firstName: "Dana", lastName: "Reed" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "TILL-01",
      status: "ORDER",
      orderDate: new Date("2026-11-01"),
      customerId: customer.id,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            partNo: "ITEM-1",
            netPrice: 1000,
            cost: 400,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
  return { register, cashier, till, order };
}

const cash = (tillId: number, registerId: number, amount: number) => ({
  method: "CASH",
  amount,
  tillId,
  registerId,
  createdBy: "cashier@example.com",
});

/** A second connection, to hold a row while the code under test waits on it. */
function secondConnection() {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
  });
}

/** Until a session other than this one is waiting on a lock. */
async function untilAnotherWaits(tx: Prisma.TransactionClient) {
  for (let i = 0; i < 200; i++) {
    // Activity is read once per transaction unless the snapshot is cleared.
    await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text AS cleared`;
    const [{ waiting }] = await tx.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Nothing ever waited on the till's row.");
}

describe("closing a till while money is being booked against it", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("counts a payment that lands after the close was asked for and before it writes", async () => {
    const { till, register, order } = await fixtures();
    // The drawer holds the $200 float and $150 the cashier is still ringing up.
    // The payment commits once the close has done everything it does ahead of
    // its transaction.
    let paid = false;
    const closing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<typeof prisma.$transaction>) => {
          if (!paid) {
            paid = true;
            await recordPayment(order.id, cash(till.id, register.id, 150));
          }
          return target.$transaction(...args);
        };
      },
    });
    const res = makeRes();

    await handleClose(makeReq(till.id, { actualCash: 350 }), res, cashierSession, closing);

    // The sum taken ahead of the transaction said $200: a $150 overage, which
    // needs a note, so the close was refused for a difference that wasn't there.
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ expectedCash: 350, actualCash: 350, variance: 0 });
  });

  it("waits for a payment in flight, and counts it", async () => {
    const { till, register, order } = await fixtures();
    const paying = secondConnection();
    const res = makeRes();
    let close: Promise<void> | undefined;
    try {
      await paying.$transaction(
        async (tx) => {
          // A cash payment part-way through: the till held open, the row written.
          await tx.$queryRaw`SELECT id FROM "Till" WHERE id = ${till.id} FOR SHARE`;
          await tx.payment.create({
            data: {
              salesOrderId: order.id,
              paymentDate: new Date(),
              paymentType: "Cash",
              method: "CASH",
              paymentAmount: 150,
              status: "COMPLETED",
              tillId: till.id,
              registerId: register.id,
            },
          });
          close = handleClose(makeReq(till.id, { actualCash: 350 }), res, cashierSession, prisma);
          close.catch(() => undefined); // surfaced by the await below
          await untilAnotherWaits(tx);
        },
        { maxWait: 10000, timeout: 30000 },
      );
    } finally {
      await paying.$disconnect();
    }
    await close;

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ expectedCash: 350, variance: 0 });
  });

  it("makes a payment wait for a close in progress, then refuses it", async () => {
    const { till, register, order } = await fixtures();
    const closer = secondConnection();
    let payment: Promise<unknown> | undefined;
    try {
      await closer.$transaction(
        async (tx) => {
          // A close part-way through: the till's row taken, and closed.
          await tx.$queryRaw`SELECT id FROM "Till" WHERE id = ${till.id} FOR UPDATE`;
          await tx.till.update({ where: { id: till.id }, data: { status: "CLOSED" } });
          payment = recordPayment(order.id, cash(till.id, register.id, 150));
          payment.catch(() => undefined);
          await untilAnotherWaits(tx);
        },
        { maxWait: 10000, timeout: 30000 },
      );
    } finally {
      await closer.$disconnect();
    }

    // It read the till as open and was written against it once the close had
    // committed: cash on a closed till that the close never counted.
    await expect(payment).rejects.toThrow(`Till ${till.id} is not open (status: CLOSED)`);
    expect(await prisma.payment.count({ where: { tillId: till.id } })).toBe(0);
  });

  it("lets one of two closes at once through, and tells the other the till is closed", async () => {
    const { till } = await fixtures();
    const first = makeRes();
    const second = makeRes();

    await Promise.all([
      handleClose(
        makeReq(till.id, {
          actualCash: 200,
          counts: [{ denomination: "$100", quantity: 2, amount: 200 }],
        }),
        first,
        cashierSession,
        prisma,
      ),
      handleClose(
        makeReq(till.id, {
          actualCash: 203,
          counts: [{ denomination: "$1", quantity: 203, amount: 203 }],
        }),
        second,
        cashierSession,
        prisma,
      ),
    ]);

    // Both answered 200, and the second's count replaced the first's.
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
    const refused = first.statusCode === 400 ? first : second;
    expect(refused.body).toEqual({ error: "Till is already CLOSED" });
    const winner = (first.statusCode === 200 ? first : second).body as { actualCash: number };
    const closed = await prisma.till.findUniqueOrThrow({
      where: { id: till.id },
      include: { counts: { where: { isOpening: false } } },
    });
    expect(Number(closed.actualCash)).toBe(winner.actualCash);
    expect(closed.counts.map((c) => Number(c.amount))).toEqual([winner.actualCash]);
  });

  it("lets one of two reconciles at once through, and keeps that one's note", async () => {
    const { till } = await fixtures();
    await prisma.till.update({
      where: { id: till.id },
      data: {
        status: "CLOSED",
        expectedCash: 200,
        actualCash: 188,
        variance: -12,
        notes: "short $12, coin miscount",
      },
    });
    const a = makeRes();
    const b = makeRes();

    await Promise.all([
      handleReconcile(makeReq(till.id, { notes: "approved - A" }), a, cashierSession, prisma),
      handleReconcile(makeReq(till.id, { notes: "approved - B" }), b, cashierSession, prisma),
    ]);

    // Both answered 200, and one manager's approval was written over.
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const refused = a.statusCode === 400 ? a : b;
    expect(refused.body).toEqual({ error: "Till must be CLOSED before reconciliation" });
    const kept = a.statusCode === 200 ? "approved - A" : "approved - B";
    const now = await prisma.till.findUniqueOrThrow({ where: { id: till.id } });
    expect(now.status).toBe("RECONCILED");
    expect(now.notes).toBe(`short $12, coin miscount\n${kept}`);
  });

  it("does not book a refund against a closed till", async () => {
    const { till, register, order } = await fixtures();
    const taken = await recordPayment(order.id, cash(till.id, register.id, 300));
    await prisma.till.update({ where: { id: till.id }, data: { status: "CLOSED" } });

    const refund = processRefund(taken.id, {
      amount: 100,
      reason: "Changed their mind",
      tillId: till.id,
      registerId: register.id,
      createdBy: "cashier@example.com",
    });

    // It was written against the closed till, and the till's count never saw it.
    await expect(refund).rejects.toBeInstanceOf(RefundError);
    await expect(refund).rejects.toThrow(/till is closed, so the refund was not made/);
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });
});
