// /app/__tests__/integration/giftCardLedger.integration.test.ts
//
// A gift card's balance changes only when money moves, each change with its history row in one
// transaction (owner, 2026-11-11; lib/giftCardLedger.ts). Against a real database: spending at the
// register is locked and refuses a retired card, a card spent to $0 is REDEEMED and can be
// reloaded, a refund goes back on the card unless it was retired, a card is retired only by moving
// its balance to a new one, and a re-import records what it changes. Every card's history adds up
// to its balance. next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { processRefund, recordPayment } from "@/lib/paymentService";
import { creditToCard } from "@/lib/giftCardLedger";
import replaceRoute from "@/pages/api/gift-cards/[id]/replace";
import importRoute from "@/pages/api/gift-cards/import";

const sessionMock = getServerSession as jest.Mock;

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, body: object, query: Record<string, string> = {}) {
  const res = {
    statusCode: 200,
    body: undefined as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  const req = {
    method: "POST",
    query,
    body,
    cookies: {},
    headers: {},
  } as unknown as NextApiRequest;
  await route(req, res as unknown as NextApiResponse);
  return res;
}

let orderId: number;

async function newCard(barcode: string, balance: number) {
  const card = await prisma.giftCard.create({
    data: { barcode, initialAmount: balance, currentBalance: balance, status: "ACTIVE" },
  });
  await prisma.giftCardTransaction.create({
    data: {
      giftCardId: card.id,
      transactionType: "ISSUANCE",
      amount: balance,
      balanceBefore: 0,
      balanceAfter: balance,
    },
  });
  return card;
}

/** Its history adds up to its balance, and each row's before + amount = after. */
async function expectHistoryAddsUp(cardId: number) {
  const card = await prisma.giftCard.findUniqueOrThrow({
    where: { id: cardId },
    include: { transactions: { orderBy: { id: "asc" } } },
  });
  const sum = card.transactions.reduce((s, t) => s + Number(t.amount), 0);
  expect(Math.round(sum * 100) / 100).toBe(Number(card.currentBalance));
  for (const t of card.transactions) {
    expect(Number(t.balanceBefore) + Number(t.amount)).toBeCloseTo(Number(t.balanceAfter), 2);
  }
  return card;
}

// A reload is a line on a sale (giftCardSale.integration.test.ts); here, the ledger's own.
const reload = (cardId: number, amount: number) =>
  prisma.$transaction((tx) =>
    creditToCard(tx, { cardId, amount, type: "RELOAD", createdBy: "owner@example.com" }),
  );

const pay = (giftCardId: number, amount: number) =>
  recordPayment(orderId, {
    method: "GIFT_CARD",
    amount,
    giftCardId,
    createdBy: "owner@example.com",
  });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "owner", displayName: "Owner", role: "SUPER_ADMIN", roleId: role.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });
  const customer = await prisma.customer.create({
    data: { firstName: "Ada", lastName: "Fenwick" },
  });
  orderId = (
    await prisma.salesOrder.create({
      data: {
        orderno: "GC-1",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        lineItems: {
          create: [
            { lineNumber: 1, netPrice: 500, cost: 0, orderedQuantity: 1, lineItemStatus: "ACTIVE" },
          ],
        },
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("spending a card at the register", () => {
  it("two spends of one balance can't both pass", async () => {
    const card = await newCard("GC-RACE", 100);

    const results = await Promise.allSettled([pay(card.id, 80), pay(card.id, 80)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toContain("Insufficient gift card balance");
    const after = await expectHistoryAddsUp(card.id);
    expect(Number(after.currentBalance)).toBe(20);
  });

  it("a card spent to $0 is Redeemed, and a reload makes it Active again", async () => {
    const card = await newCard("GC-ZERO", 50);
    await pay(card.id, 50);
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      "REDEEMED",
    );

    await reload(card.id, 25);

    const after = await expectHistoryAddsUp(card.id);
    expect(after).toMatchObject({ status: "ACTIVE" });
    expect(Number(after.currentBalance)).toBe(25);
  });

  it("a refund goes back on the card it came off", async () => {
    const card = await newCard("GC-REFUND", 60);
    const payment = await pay(card.id, 60);

    await processRefund(payment.id, {
      amount: 40,
      reason: "Changed mind",
      createdBy: "owner@example.com",
    });

    const after = await expectHistoryAddsUp(card.id);
    expect(after).toMatchObject({ status: "ACTIVE" });
    expect(Number(after.currentBalance)).toBe(40);
    expect(after.transactions.at(-1)).toMatchObject({ transactionType: "REFUND" });
  });
});

describe("retiring a card: its balance moves to a new one", () => {
  it("moves the whole balance, links the cards, and both histories add up", async () => {
    const old = await newCard("GC-OLD", 75);
    await pay(old.id, 25);

    const res = await call(replaceRoute, { barcode: "GC-NEW" }, { id: String(old.id) });

    expect(res.statusCode).toBe(200);
    expect(res.body.moved).toBe(50);
    const retired = await expectHistoryAddsUp(old.id);
    expect(retired).toMatchObject({ status: "REPLACED", replacedById: res.body.newCardId });
    expect(Number(retired.currentBalance)).toBe(0);
    const fresh = await expectHistoryAddsUp(res.body.newCardId);
    expect(fresh).toMatchObject({ barcode: "GC-NEW", status: "ACTIVE" });
    expect(Number(fresh.currentBalance)).toBe(50);
  });

  it("a retired card can't be spent, reloaded, moved again or refunded onto", async () => {
    const old = await newCard("GC-GONE", 80);
    const payment = await pay(old.id, 30);
    await call(replaceRoute, { barcode: "GC-HERE" }, { id: String(old.id) });

    await expect(pay(old.id, 1)).rejects.toThrow("moved to a new card");
    await expect(reload(old.id, 10)).rejects.toThrow("moved to a new card");
    const again = await call(replaceRoute, { barcode: "GC-OTHER" }, { id: String(old.id) });
    expect(again.statusCode).toBe(400);
    await expect(
      processRefund(payment.id, { amount: 30, createdBy: "owner@example.com" }),
    ).rejects.toThrow("Refund it to store credit instead");

    const retired = await expectHistoryAddsUp(old.id);
    expect(Number(retired.currentBalance)).toBe(0);
    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
  });

  it("a card voided before Void was removed can't pay, even with money left on it", async () => {
    // The old bug: a refund re-credited a voided card, and the register checked only the balance.
    const voided = await prisma.giftCard.create({
      data: { barcode: "GC-VOIDED", initialAmount: 50, currentBalance: 50, status: "VOIDED" },
    });

    await expect(pay(voided.id, 10)).rejects.toThrow("was voided");
    const after = await prisma.giftCard.findUniqueOrThrow({ where: { id: voided.id } });
    expect(Number(after.currentBalance)).toBe(50);
  });

  it("won't move a balance onto a card number already in use, or onto nothing", async () => {
    const old = await newCard("GC-A", 40);
    await newCard("GC-B", 10);

    expect((await call(replaceRoute, { barcode: "GC-B" }, { id: String(old.id) })).statusCode).toBe(
      400,
    );
    expect((await call(replaceRoute, { barcode: " " }, { id: String(old.id) })).statusCode).toBe(
      400,
    );
    const still = await expectHistoryAddsUp(old.id);
    expect(still).toMatchObject({ status: "ACTIVE" });
  });
});

describe("re-importing cards", () => {
  const row = (Referenceno: string, Remainingamount: string) => ({
    Creationdate: "2026-01-05",
    Code: `V-${Referenceno}`,
    Referenceno,
    Initialamount: "100",
    Remainingamount,
  });

  it("a re-import fills in an untouched card, and leaves a retired or used one as Holt has it", async () => {
    const first = await call(importRoute, {
      records: [row("IMP-1", "100"), row("IMP-2", "40"), row("IMP-4", "90")],
    });
    expect(first.body).toMatchObject({ importedCount: 3, errorCount: 0 });
    const two = await prisma.giftCard.findUniqueOrThrow({ where: { barcode: "IMP-2" } });
    await call(replaceRoute, { barcode: "IMP-2-NEW" }, { id: String(two.id) });
    const four = await prisma.giftCard.findUniqueOrThrow({ where: { barcode: "IMP-4" } });
    await pay(four.id, 30);

    const again = await call(importRoute, {
      records: [
        row("IMP-1", "70"),
        row("IMP-2", "40"),
        row("IMP-4", "90"),
        row("IMP-3", "not a number"),
      ],
    });

    expect(again.body).toMatchObject({ updatedCount: 1, errorCount: 3 });
    expect(again.body.errors.join(" | ")).toContain("was retired in Holt");
    expect(again.body.errors.join(" | ")).toContain("has been used in Holt");
    expect(again.body.errors.join(" | ")).toContain("the amount can't be read");
    const one = await expectHistoryAddsUp(
      (await prisma.giftCard.findUniqueOrThrow({ where: { barcode: "IMP-1" } })).id,
    );
    expect(Number(one.currentBalance)).toBe(70);
    expect(one.transactions.at(-1)).toMatchObject({ transactionType: "IMPORT" });
    expect(Number(one.transactions.at(-1)!.amount)).toBe(-30);
    const retired = await expectHistoryAddsUp(two.id);
    expect(retired.status).toBe("REPLACED");
    // The $30 spent in Holt stands; the report's $90 doesn't undo it.
    const used = await expectHistoryAddsUp(four.id);
    expect(Number(used.currentBalance)).toBe(60);
    expect(await prisma.giftCard.count({ where: { barcode: "IMP-3" } })).toBe(0);
  });
});
