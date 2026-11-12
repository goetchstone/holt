// /app/__tests__/integration/giftCardSale.integration.test.ts
//
// A gift card is sold and reloaded as a line on a sale, paid like any sale (owner, 2026-11-11),
// and "the card goes live when the sale is paid in full". So create-from-cart writes the line
// (refusing a retired card, the same number twice, an amount that isn't whole cents above zero),
// and the payment that pays the sale off issues the card through the card ledger in its own
// transaction: at the register (recordPaymentTx) and from a processor (completePayment). A card
// line is owed, so it's in the balance, but it isn't revenue, goods, stock or a PO. Every card's
// history adds up to its balance. Real routes, real database.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import {
  calculateOrderBalance,
  completePayment,
  onPaymentReceived,
  recordPayment,
  recordPaymentTx,
  recordPendingPayment,
} from "@/lib/paymentService";
import { issueCard, spendFromCard, replaceCard } from "@/lib/giftCardLedger";
import { getSalesDaily } from "@/lib/reports/salesDaily";
import { rerateQuoteTax } from "@/lib/tax/rerateQuoteTax";
import { duplicateOrder } from "@/lib/sales/duplicateOrder";
import { cancelOrder } from "@/lib/sales/cancelOrder";
import { getAppSettings } from "@/lib/appSettings";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as returnsRoute } from "@/pages/api/returns/index";

const session = { user: { email: "register@example.com" } } as unknown as Session;
const ACTOR = "register@example.com";

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
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
  return res as unknown as TestRes;
}

let store: { id: number; name: string };
let sofa: { id: number };

/** A card line as the register posts it. */
const card = (giftCardNumber: string, amount: number) => ({
  type: "GIFT_CARD",
  giftCardNumber,
  amount,
});

/** The register's sofa, $1,000, taxed at 6%. */
const sofaLine = () => ({ productId: sofa.id, quantity: 1, unitPrice: 1000 });

async function sell(items: object[]): Promise<TestRes> {
  const res = makeRes();
  await createFromCart(
    { method: "POST", query: {}, body: { storeLocation: store.name, items } } as NextApiRequest,
    res,
    session,
  );
  return res;
}

async function sold(items: object[]): Promise<{ id: number; orderno: string; total: number }> {
  const res = await sell(items);
  expect(res.statusCode).toBe(201);
  return res.body;
}

const cash = (orderId: number, amount: number) =>
  recordPayment(orderId, { method: "CASH", amount, createdBy: ACTOR });

/** Its history adds up to its balance, and each row's before + amount = after. */
async function expectHistoryAddsUp(barcode: string) {
  const found = await prisma.giftCard.findUniqueOrThrow({
    where: { barcode },
    include: { transactions: { orderBy: { id: "asc" } } },
  });
  const sum = found.transactions.reduce((s, t) => s + Number(t.amount), 0);
  expect(Math.round(sum * 100) / 100).toBe(Number(found.currentBalance));
  for (const t of found.transactions) {
    expect(Number(t.balanceBefore) + Number(t.amount)).toBeCloseTo(Number(t.balanceAfter), 2);
  }
  return found;
}

const cardLineOf = (orderId: number) =>
  prisma.orderLineItem.findFirstOrThrow({
    where: { salesOrderId: orderId, giftCardNumber: { not: null } },
  });

beforeEach(async () => {
  await resetTestDb();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  // The store allows a sale with nothing paid, so the test shows a gift card sale never is.
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, appName: "Holt", allowSaleWithoutPayment: true },
  });
  invalidateAppSettingsCache();

  const vendor = await prisma.vendor.create({ data: { name: "Sofa Maker", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const district = await prisma.taxDistrict.create({
    data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
  });
  const group = await prisma.taxGroup.create({ data: { name: "Standard Retail" } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: group.id, taxRate: 0.06, sortOrder: 0 },
  });
  store = await prisma.storeLocation.create({
    data: { name: "Main Store", code: "MS", type: "STORE", taxDistrictId: district.id },
  });
  sofa = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
      baseRetail: 1000,
      baseCost: 400,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("selling a new card", () => {
  it("writes a line that is only the card's amount, and issues the card when it's paid in cash", async () => {
    const res = await sell([card("GC-100", 50)]);

    expect(res.statusCode).toBe(201);
    // No tax, no discount; the register isn't offered to go ahead unpaid.
    expect(res.body).toMatchObject({
      subtotal: 50,
      taxAmount: 0,
      total: 50,
      allowSaleWithoutPayment: false,
    });
    const line = await cardLineOf(res.body.id);
    expect(line).toMatchObject({
      productId: null,
      productName: "Gift card",
      partNo: "",
      giftCardNumber: "GC-100",
      giftCardId: null,
    });
    expect(Number(line.orderedQuantity)).toBe(1);
    expect(Number(line.netPrice)).toBe(50);
    expect(Number(line.vatAmount)).toBe(0);
    expect(Number(line.cost)).toBe(0);
    // Nothing is on a card until the sale is paid.
    expect(await prisma.giftCard.count()).toBe(0);

    await cash(res.body.id, 50);

    const issued = await expectHistoryAddsUp("GC-100");
    expect(issued).toMatchObject({ status: "ACTIVE", createdBy: ACTOR });
    expect(Number(issued.currentBalance)).toBe(50);
    expect(Number(issued.initialAmount)).toBe(50);
    expect(issued.transactions).toHaveLength(1);
    expect(issued.transactions[0]).toMatchObject({
      transactionType: "ISSUANCE",
      reference: `Order ${res.body.orderno}`,
    });
    expect(Number(issued.transactions[0].balanceBefore)).toBe(0);
    expect((await cardLineOf(res.body.id)).giftCardId).toBe(issued.id);
  });

  it("issues nothing on a part payment, not even one short by less than a dollar; the payment that pays it off issues it", async () => {
    // $1,000 sofa + $60 tax + a $100 card.
    const order = await sold([sofaLine(), card("GC-PART", 100)]);
    expect(order.total).toBe(1160);

    await cash(order.id, 500);
    expect(await prisma.giftCard.count()).toBe(0);
    // The order's balance reads $0 here (a balance under $1 is snapped), but 50 cents is owed.
    await cash(order.id, 659.5);
    expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
    expect(await prisma.giftCard.count()).toBe(0);

    await cash(order.id, 0.5);

    const issued = await expectHistoryAddsUp("GC-PART");
    expect(Number(issued.currentBalance)).toBe(100);
  });

  it("issues once, at the last of split tenders, and a later payment doesn't issue it again", async () => {
    const order = await sold([card("GC-SPLIT", 80)]);

    await recordPayment(order.id, { method: "CARD", amount: 30, createdBy: ACTOR });
    expect(await prisma.giftCard.count()).toBe(0);
    await cash(order.id, 50);
    await cash(order.id, 5);

    const issued = await expectHistoryAddsUp("GC-SPLIT");
    expect(Number(issued.currentBalance)).toBe(80);
    expect(issued.transactions).toHaveLength(1);
  });

  it("issues it when two tenders land together, neither seeing the other's payment yet", async () => {
    const order = await sold([card("GC-RACE", 80)]);

    // The first tender's transaction stays open after its payment is written, while the second
    // lands. Unlocked, each reads only its own payment, finds the sale short, and the card is
    // never issued. Locked, the second waits for the first to commit, then sees both.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let wrote!: () => void;
    const firstWrote = new Promise<void>((resolve) => (wrote = resolve));
    const first = prisma.$transaction(async (tx) => {
      await recordPaymentTx(tx, order.id, { method: "CASH", amount: 30, createdBy: ACTOR });
      wrote();
      await held;
    });
    await firstWrote;
    const second = cash(order.id, 50);
    setTimeout(release, 500);
    await Promise.all([first, second]);

    const issued = await expectHistoryAddsUp("GC-RACE");
    expect(Number(issued.currentBalance)).toBe(80);
    expect(issued.transactions).toHaveLength(1);
  });
});

describe("reloading a card on a sale", () => {
  it("adds the line's amount to the open card with a RELOAD row", async () => {
    await prisma.$transaction(async (tx) => {
      const { cardId } = await issueCard(tx, { barcode: "GC-RL", amount: 20, createdBy: ACTOR });
      await spendFromCard(tx, { cardId, amount: 20, createdBy: ACTOR });
    });
    const order = await sold([card("GC-RL", 30)]);
    expect((await cardLineOf(order.id)).productName).toBe("Gift card reload");

    await cash(order.id, 30);

    const reloaded = await expectHistoryAddsUp("GC-RL");
    // Spent to $0 it was Redeemed; reloaded it's Active again.
    expect(reloaded.status).toBe("ACTIVE");
    expect(Number(reloaded.currentBalance)).toBe(30);
    expect(reloaded.transactions.at(-1)).toMatchObject({
      transactionType: "RELOAD",
      reference: `Order ${order.orderno}`,
    });
    expect((await cardLineOf(order.id)).giftCardId).toBe(reloaded.id);
  });

  it("refuses the payment, and moves no money, when the card was retired after it was rung up", async () => {
    await prisma.$transaction((tx) =>
      issueCard(tx, { barcode: "GC-LATE", amount: 10, createdBy: ACTOR }),
    );
    const order = await sold([card("GC-LATE", 25)]);
    const old = await prisma.giftCard.findUniqueOrThrow({ where: { barcode: "GC-LATE" } });
    await prisma.$transaction((tx) =>
      replaceCard(tx, { cardId: old.id, newBarcode: "GC-LATE-2", createdBy: ACTOR }),
    );

    await expect(cash(order.id, 25)).rejects.toThrow("moved to a new card");

    expect(await prisma.payment.count({ where: { salesOrderId: order.id } })).toBe(0);
    expect((await cardLineOf(order.id)).giftCardId).toBeNull();
    await expectHistoryAddsUp("GC-LATE");
  });
});

describe("what create-from-cart refuses", () => {
  it("a retired card, the same number twice, and an amount that isn't whole cents above zero", async () => {
    await prisma.$transaction(async (tx) => {
      const { cardId } = await issueCard(tx, { barcode: "GC-OLD", amount: 40, createdBy: ACTOR });
      await replaceCard(tx, { cardId, newBarcode: "GC-NEW", createdBy: ACTOR });
    });
    const newId = (await prisma.giftCard.findUniqueOrThrow({ where: { barcode: "GC-NEW" } })).id;

    const retired = await sell([card("GC-OLD", 25)]);
    expect(retired.statusCode).toBe(400);
    expect(retired.body.error).toContain(`moved to card #${newId}`);

    const twice = await sell([card("GC-A", 25), sofaLine(), card(" GC-A ", 10)]);
    expect(twice.statusCode).toBe(400);
    expect(twice.body.error).toContain("on this sale twice");

    for (const amount of [0, -5, 10.005]) {
      const bad = await sell([card("GC-B", amount)]);
      expect(bad.statusCode).toBe(400);
    }
    expect((await sell([card("GC-B", 10.005)])).body.error).toContain("whole cents");
    expect((await sell([card("  ", 10)])).body.error).toContain("number");

    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("a card when the store has switched gift cards off", async () => {
    await prisma.appSettings.updateMany({ data: { features: { giftCards: false } } });
    invalidateAppSettingsCache();

    const res = await sell([card("GC-OFF", 25)]);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("switched off");
    expect(await prisma.salesOrder.count()).toBe(0);
  });
});

describe("a processor's payment", () => {
  it("that pays the sale off issues the card when the webhook completes it, once", async () => {
    const order = await sold([card("GC-WEB", 75)]);
    const pending = await recordPendingPayment(
      { orderId: order.id },
      { method: "CARD", amount: 75, processorType: "STRIPE", processorTxnId: "cs_test_gc" },
    );
    expect(await prisma.giftCard.count()).toBe(0);

    await completePayment(pending.id);
    await completePayment(pending.id);

    const issued = await expectHistoryAddsUp("GC-WEB");
    expect(Number(issued.currentBalance)).toBe(75);
    expect(issued.transactions).toHaveLength(1);
  });
});

describe("a card line is owed, but it isn't revenue, goods, stock or a PO", () => {
  it("is in the order's balance and out of the daily sales report", async () => {
    const order = await sold([sofaLine(), card("GC-REV", 100)]);

    expect((await calculateOrderBalance(order.id)).totalDue).toBe(1160);
    await cash(order.id, 1160);
    await onPaymentReceived(order.id);

    const rows = await getSalesDaily(prisma);
    expect(rows.reduce((sum, row) => sum + row.totalSales, 0)).toBe(1000);
    expect((await calculateOrderBalance(order.id)).balanceDue).toBe(0);
  });

  it("raises no PO and commits no stock for the card, only for the goods", async () => {
    const order = await sold([sofaLine(), card("GC-PO", 100)]);
    await cash(order.id, 1160);
    await onPaymentReceived(order.id);

    const cardLine = await cardLineOf(order.id);
    expect(cardLine.productId).toBeNull();
    const poItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { salesOrderId: order.id } },
    });
    expect(poItems.map((i) => i.productId)).toEqual([sofa.id]);
    expect(poItems.some((i) => i.orderLineItemId === cardLine.id)).toBe(false);

    const cardOnly = await sold([card("GC-ONLY", 40)]);
    await cash(cardOnly.id, 40);
    await onPaymentReceived(cardOnly.id);
    expect(await prisma.purchaseOrder.count({ where: { salesOrderId: cardOnly.id } })).toBe(0);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: cardOnly.id } })).toBe(0);
    expect(await prisma.inventoryException.count({ where: { salesOrderId: cardOnly.id } })).toBe(0);
    expect((await prisma.salesOrder.findUniqueOrThrow({ where: { id: cardOnly.id } })).status).toBe(
      "ORDER",
    );
  });
});

describe("a card line after the sale is written", () => {
  async function changeLine(orderId: number, lineId: number, method: string, body: object = {}) {
    const res = makeRes();
    await lineRoute(
      {
        method,
        query: { id: String(orderId), lineItemId: String(lineId) },
        body,
      } as unknown as NextApiRequest,
      res,
      session,
    );
    return res;
  }

  it("can't have its price changed, but can come off a quote before its card is issued", async () => {
    const order = await sold([sofaLine(), card("GC-EDIT", 50)]);
    const line = await cardLineOf(order.id);

    const priced = await changeLine(order.id, line.id, "PUT", { action: "update", unitPrice: 40 });
    expect(priced.statusCode).toBe(409);
    expect(priced.body.error).toContain("can't be changed");
    const relinked = await changeLine(order.id, line.id, "PUT", {
      action: "relink",
      productId: sofa.id,
    });
    expect(relinked.statusCode).toBe(409);
    expect(Number((await cardLineOf(order.id)).netPrice)).toBe(50);

    const removed = await changeLine(order.id, line.id, "DELETE");
    expect(removed.statusCode).toBe(204);
  });

  it("can't be cancelled once its card is live, on its own or with the whole sale", async () => {
    const order = await sold([card("GC-LIVE", 50)]);
    await cash(order.id, 50);
    await onPaymentReceived(order.id);
    const line = await cardLineOf(order.id);

    const cancelled = await changeLine(order.id, line.id, "PUT", {
      action: "cancel",
      reason: "Changed mind",
    });
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.body.error).toContain("GC-LIVE is live");
    await expect(
      cancelOrder(order.id, {
        reason: "Changed mind",
        destination: "ORIGINAL_PAYMENT",
        actor: ACTOR,
      }),
    ).rejects.toThrow("GC-LIVE is live");
    const returned = makeRes();
    await returnsRoute(
      {
        method: "POST",
        query: {},
        body: { salesOrderId: order.id, lineItemId: line.id, reason: "CUSTOMER_CHANGED_MIND" },
      } as unknown as NextApiRequest,
      returned,
      session,
    );
    expect(returned.statusCode).toBe(409);
    expect(returned.body.error).toContain("GC-LIVE is live");
    expect(await prisma.return.count()).toBe(0);
    // A note still goes on.
    const noted = await changeLine(order.id, line.id, "PUT", { action: "note", notes: "Gift" });
    expect(noted.statusCode).toBe(200);

    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
    const live = await expectHistoryAddsUp("GC-LIVE");
    expect(Number(live.currentBalance)).toBe(50);
  });

  it("isn't taxed when a quote's tax is re-rated, and isn't copied with the sale", async () => {
    const order = await sold([sofaLine(), card("GC-QUOTE", 50)]);

    await prisma.$transaction((tx) => rerateQuoteTax(tx, order.id));

    const line = await cardLineOf(order.id);
    expect(Number(line.vatAmount)).toBe(0);
    const quote = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(quote.totalTax)).toBe(60);

    const settings = await getAppSettings();
    const copy = await prisma.$transaction((tx) =>
      duplicateOrder(tx, {
        orderId: order.id,
        actor: { email: ACTOR, displayName: "Register" },
        settings,
      }),
    );
    const copied = await prisma.orderLineItem.findMany({ where: { salesOrderId: copy.id } });
    expect(copied.map((l) => l.productId)).toEqual([sofa.id]);
    expect(copied.some((l) => l.giftCardNumber != null || l.productName === "Gift card")).toBe(
      false,
    );
  });
});
