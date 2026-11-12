// /app/__tests__/integration/giftCardSaleBooks.integration.test.ts
//
// A gift card sold on a sale, in the books and back out again (owner, 2026-11-11: every money
// change is transactional and on a ledger, nothing appears or vanishes, and a card's value is a
// liability until it's spent). The sales journal moves the money paid for a card line from the
// deposit (or receivable) it was paid into to 2-2127 on the day the card is issued, from the
// card's own ledger row, and the daily reconciliation agrees. A live card comes back only where
// the store refunds cards ("Most places will not refund a giftcard ... this should be a config
// and then only if unused"): its value comes off the card in the transaction of the money that
// goes back, through a whole-sale cancel, cancelling its line, or its return. Real routes, real
// database.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, getBusinessTimeZone, invalidateAppSettingsCache } from "@/lib/appSettings";
import { onPaymentReceived, recordPayment } from "@/lib/paymentService";
import { issueCard, spendFromCard } from "@/lib/giftCardLedger";
import { cancelOrder } from "@/lib/sales/cancelOrder";
import { refundReturn } from "@/lib/returns/refundReturn";
import { generateSalesJournal } from "@/lib/journalEntry";
import { computeDailyReconciliation } from "@/lib/dailyReconciliation";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as returnsRoute } from "@/pages/api/returns/index";
import { posted } from "../helpers/postedJournal";

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
let gl: Record<"cash" | "deposits" | "giftCards" | "ar" | "sales" | "tax", number>;

const card = (giftCardNumber: string, amount: number) => ({
  type: "GIFT_CARD",
  giftCardNumber,
  amount,
});
/** $1,000, taxed at 6%, costing $400. */
const sofaLine = () => ({ productId: sofa.id, quantity: 1, unitPrice: 1000 });

async function sold(items: object[]): Promise<{ id: number; orderno: string }> {
  const res = makeRes();
  await createFromCart(
    { method: "POST", query: {}, body: { storeLocation: store.name, items } } as NextApiRequest,
    res,
    session,
  );
  expect(res.statusCode).toBe(201);
  return res.body;
}

/** Paid at the register: the payment, then what the payment route does after it. */
async function cash(orderId: number, amount: number) {
  const payment = await recordPayment(orderId, { method: "CASH", amount, createdBy: ACTOR });
  await onPaymentReceived(orderId);
  return payment;
}

const cardLineOf = (orderId: number) =>
  prisma.orderLineItem.findFirstOrThrow({
    where: { salesOrderId: orderId, giftCardNumber: { not: null } },
  });

async function refundsCards(on: boolean) {
  await prisma.appSettings.update({
    where: { organizationId: DEFAULT_ORG_ID },
    data: { giftCardsRefundable: on },
  });
  invalidateAppSettingsCache();
}

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

async function cancelLine(orderId: number, lineId: number, body: object) {
  const res = makeRes();
  await lineRoute(
    {
      method: "PUT",
      query: { id: String(orderId), lineItemId: String(lineId) },
      body,
    } as unknown as NextApiRequest,
    res,
    session,
    { holds: { "payment.refund": true } },
  );
  return res;
}

async function startReturn(orderId: number, lineId: number) {
  const res = makeRes();
  await returnsRoute(
    {
      method: "POST",
      query: {},
      body: { salesOrderId: orderId, lineItemId: lineId, reason: "CUSTOMER_CHANGED_MIND" },
    } as unknown as NextApiRequest,
    res,
    session,
  );
  return res;
}

// ─── The books ───────────────────────────────────────────────────────

/** The journal's date marker for the business day `offset` days from today. */
async function dayMarker(offset = 0): Promise<{ marker: Date; key: string }> {
  const key = addDays(businessDayKey(new Date(), await getBusinessTimeZone()), offset);
  return { marker: new Date(`${key}T00:00:00Z`), key };
}

/** Generate, check it balanced on its own, and post it so the reconciliation reads it. */
async function journalFor(marker: Date) {
  const result = await generateSalesJournal(marker, ACTOR);
  const je = posted(result);
  expect(result.overShort).toBe(0);
  expect(je.totalDebits).toBeCloseTo(je.totalCredits, 2);
  expect(result.warnings.filter((w) => !w.includes("No AccountGroup"))).toEqual([]);
  await prisma.journalEntry.update({ where: { id: je.id }, data: { status: "POSTED" } });
  return je;
}

/** credits - debits on one account, across entries. */
function creditsOn(
  entries: { lines: { glAccount: { id: number }; debit: number; credit: number }[] }[],
  accountId: number,
): number {
  const net = entries
    .flatMap((e) => e.lines)
    .filter((l) => l.glAccount.id === accountId)
    .reduce((s, l) => s + l.credit - l.debit, 0);
  return Math.round(net * 100) / 100;
}

async function reconcile(marker: Date) {
  return computeDailyReconciliation({
    date: marker,
    timeZone: await getBusinessTimeZone(),
    client: prisma,
  });
}

beforeEach(async () => {
  await resetTestDb();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, appName: "Holt", allowSaleWithoutPayment: true },
  });
  invalidateAppSettingsCache();

  const account = (code: string, name: string, accountType: string) =>
    prisma.gLAccount.create({ data: { code, name, accountType } });
  const cashGl = await account("1-1006", "Cash", "ASSET");
  const deposits = await account("1-1200", "Customer Deposits", "LIABILITY");
  const giftCards = await account("2-2127", "Gift Card Liability", "LIABILITY");
  const ar = await account("1-1100", "Accounts Receivable", "ASSET");
  const sales = await account("4-4080", "Furniture Sales", "REVENUE");
  const cogs = await account("5-5280", "Furniture COGS", "EXPENSE");
  const inventory = await account("1-1380", "Furniture Inventory", "ASSET");
  const tax = await account("2-2120", "Sales Tax Payable", "LIABILITY");
  const overShort = await account("5-5900", "Cash Over/Short", "EXPENSE");
  gl = {
    cash: cashGl.id,
    deposits: deposits.id,
    giftCards: giftCards.id,
    ar: ar.id,
    sales: sales.id,
    tax: tax.id,
  };
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "POS_PAYMENTS", label: "Cash", glAccountId: cashGl.id },
      { section: "POS_PAYMENTS", label: "On Account", glAccountId: deposits.id },
      { section: "POS_PAYMENTS", label: "Gift Card", glAccountId: giftCards.id },
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: ar.id },
      { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: tax.id },
      { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: overShort.id },
    ],
  });
  const group = await prisma.accountGroup.create({
    data: {
      name: "Furniture",
      salesAccountId: sales.id,
      cogsAccountId: cogs.id,
      inventoryAccountId: inventory.id,
    },
  });

  const vendor = await prisma.vendor.create({ data: { name: "Sofa Maker", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, accountGroupId: group.id },
  });
  const district = await prisma.taxDistrict.create({
    data: { shortName: "ST", state: "MI", name: "State Sales Tax", isActive: true },
  });
  const taxGroup = await prisma.taxGroup.create({ data: { name: "Standard Retail" } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: taxGroup.id, taxRate: 0.06, sortOrder: 0 },
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

describe("the sales journal moves a card sold on a sale into the gift card liability", () => {
  it("a $100 card sold for cash: the day balances, 2-2127 is credited 100, nothing is left in deposits", async () => {
    const order = await sold([card("GC-J1", 100)]);
    await cash(order.id, 100);
    expect((await cardLineOf(order.id)).giftCardId).not.toBeNull();

    const { marker } = await dayMarker();
    const je = await journalFor(marker);

    expect(creditsOn([je], gl.giftCards)).toBe(100);
    expect(creditsOn([je], gl.deposits)).toBe(0);
    expect(creditsOn([je], gl.ar)).toBe(0);
    expect(creditsOn([je], gl.cash)).toBe(-100);
    expect(creditsOn([je], gl.sales)).toBe(0);
    expect(je.lines.find((l) => l.glAccount.id === gl.giftCards)?.memo).toBe("Gift cards sold");

    const recon = await reconcile(marker);
    expect(recon.drift).toEqual({ revenue: 0, tax: 0, cost: 0, cash: 0 });
    expect(recon.warnings).toEqual([]);
    expect(recon.balanced).toBe(true);
  });

  it("a card and a sofa paid in full: the card's 100 reaches 2-2127 the day it's issued, and the sofa is recognised when it's delivered", async () => {
    const order = await sold([sofaLine(), card("GC-J2", 100)]);
    await cash(order.id, 1160);
    const today = await dayMarker();
    const tomorrow = await dayMarker(1);

    const saleDay = await journalFor(today.marker);
    expect(creditsOn([saleDay], gl.giftCards)).toBe(100);
    // The sofa's 1,060 waits in deposits until it's delivered.
    expect(creditsOn([saleDay], gl.deposits)).toBe(1060);
    expect(creditsOn([saleDay], gl.sales)).toBe(0);

    // Delivered tomorrow: its invoice is dated then.
    await prisma.invoice.create({
      data: {
        invoiceNo: `INV-${order.id}`,
        invoiceDate: new Date(`${tomorrow.key}T16:00:00Z`),
        taxAmount: 60,
        salesOrderId: order.id,
      },
    });
    const deliveryDay = await journalFor(tomorrow.marker);
    expect(creditsOn([deliveryDay], gl.sales)).toBe(1000);
    expect(creditsOn([deliveryDay], gl.tax)).toBe(60);
    expect(creditsOn([deliveryDay], gl.giftCards)).toBe(0);
    // The deposit relieved is the sofa's, not the card's: it went to 2-2127 yesterday.
    expect(creditsOn([deliveryDay], gl.deposits)).toBe(-1060);
    expect(creditsOn([deliveryDay], gl.ar)).toBe(0);

    // Across both days: the card is a liability of 100, and deposits and AR are clear.
    expect(creditsOn([saleDay, deliveryDay], gl.giftCards)).toBe(100);
    expect(creditsOn([saleDay, deliveryDay], gl.deposits)).toBe(0);
    expect(creditsOn([saleDay, deliveryDay], gl.ar)).toBe(0);

    // The card's money reconciles on both days: no cash drift. The sofa's revenue is counted on
    // its order day by the reconciliation and on its delivery day by the journal, which reads as
    // revenue drift on both days whatever the card does (accounting.md, gaps).
    const saleRecon = await reconcile(today.marker);
    expect(saleRecon.drift).toEqual({ revenue: 1000, tax: 60, cost: 400, cash: 0 });
    const deliveryRecon = await reconcile(tomorrow.marker);
    expect(deliveryRecon.drift).toEqual({ revenue: -1000, tax: -60, cost: -400, cash: 0 });
  });
});

describe("cancelling or returning a live card", () => {
  it("is refused while the store doesn't refund cards, naming the setting, and nothing moves", async () => {
    const order = await sold([sofaLine(), card("GC-OFF", 100)]);
    await cash(order.id, 1160);
    const line = await cardLineOf(order.id);

    const cancelled = await cancelLine(order.id, line.id, {
      action: "cancel",
      reason: "Changed mind",
      destination: "ORIGINAL_PAYMENT",
    });
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.body.error).toContain("GC-OFF is live");
    expect(cancelled.body.error).toContain("Refund unused gift cards");
    await expect(
      cancelOrder(order.id, {
        reason: "Changed mind",
        destination: "ORIGINAL_PAYMENT",
        actor: ACTOR,
      }),
    ).rejects.toThrow("Refund unused gift cards");
    const returned = await startReturn(order.id, line.id);
    expect(returned.statusCode).toBe(409);
    expect(returned.body.error).toContain("Refund unused gift cards");

    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
    expect(await prisma.return.count()).toBe(0);
    const live = await expectHistoryAddsUp("GC-OFF");
    expect(Number(live.currentBalance)).toBe(100);
  });

  it("cancelling an unused card's line takes it to $0 and refunds its money, and the day balances", async () => {
    await refundsCards(true);
    const order = await sold([sofaLine(), card("GC-LINE", 100)]);
    await cash(order.id, 1160);
    const line = await cardLineOf(order.id);

    const res = await cancelLine(order.id, line.id, {
      action: "cancel",
      reason: "Changed mind",
      destination: "ORIGINAL_PAYMENT",
    });
    expect(res.statusCode).toBe(200);

    const after = await expectHistoryAddsUp("GC-LINE");
    expect(Number(after.currentBalance)).toBe(0);
    expect(after.status).toBe("REDEEMED");
    expect(after.transactions.map((t) => [t.transactionType, Number(t.amount)])).toEqual([
      ["ISSUANCE", 100],
      ["REFUND", -100],
    ]);
    expect(after.transactions.every((t) => t.orderLineItemId === line.id)).toBe(true);
    const refunds = await prisma.payment.findMany({ where: { isRefund: true } });
    expect(refunds.map((r) => Number(r.paymentAmount))).toEqual([100]);
    expect((await cardLineOf(order.id)).lineItemStatus).toBe("CANCELLED");

    // In and out the same day: 2-2127 nets to nothing, and the sofa's money waits in deposits.
    const { marker } = await dayMarker();
    const je = await journalFor(marker);
    expect(creditsOn([je], gl.giftCards)).toBe(0);
    expect(creditsOn([je], gl.deposits)).toBe(1060);
    expect(creditsOn([je], gl.cash)).toBe(-1060);
  });

  it("cancelling the whole sale takes an unused card to $0 in the refund's transaction", async () => {
    await refundsCards(true);
    const order = await sold([card("GC-WHOLE", 100)]);
    await cash(order.id, 100);

    const result = await cancelOrder(order.id, {
      reason: "Changed mind",
      destination: "ORIGINAL_PAYMENT",
      actor: ACTOR,
    });
    expect(result.refunded).toBe(100);

    const after = await expectHistoryAddsUp("GC-WHOLE");
    expect(Number(after.currentBalance)).toBe(0);
    expect(after.transactions.map((t) => t.transactionType)).toEqual(["ISSUANCE", "REFUND"]);
    expect((await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CANCELLED",
    );
  });

  it("a cancelled reload leaves the card at its balance from before the reload", async () => {
    await refundsCards(true);
    await prisma.$transaction((tx) =>
      issueCard(tx, { barcode: "GC-RELOAD", amount: 30, createdBy: ACTOR }),
    );
    const order = await sold([card("GC-RELOAD", 50)]);
    await cash(order.id, 50);
    const line = await cardLineOf(order.id);

    const res = await cancelLine(order.id, line.id, {
      action: "cancel",
      reason: "Changed mind",
      destination: "ORIGINAL_PAYMENT",
    });
    expect(res.statusCode).toBe(200);

    const after = await expectHistoryAddsUp("GC-RELOAD");
    expect(Number(after.currentBalance)).toBe(30);
    expect(after.status).toBe("ACTIVE");
    expect(after.transactions.map((t) => [t.transactionType, Number(t.amount)])).toEqual([
      ["ISSUANCE", 30],
      ["RELOAD", 50],
      ["REFUND", -50],
    ]);
  });

  it("is refused once anything has been spent from the card since its line issued it", async () => {
    await refundsCards(true);
    const order = await sold([card("GC-SPENT", 100)]);
    await cash(order.id, 100);
    const line = await cardLineOf(order.id);
    await prisma.$transaction((tx) =>
      spendFromCard(tx, { cardId: line.giftCardId as number, amount: 10, createdBy: ACTOR }),
    );

    const res = await cancelLine(order.id, line.id, {
      action: "cancel",
      reason: "Changed mind",
      destination: "ORIGINAL_PAYMENT",
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("GC-SPENT has been used");
    await expect(
      cancelOrder(order.id, {
        reason: "Changed mind",
        destination: "ORIGINAL_PAYMENT",
        actor: ACTOR,
      }),
    ).rejects.toThrow("GC-SPENT has been used");

    expect(await prisma.payment.count({ where: { isRefund: true } })).toBe(0);
    const after = await expectHistoryAddsUp("GC-SPENT");
    expect(Number(after.currentBalance)).toBe(90);
  });

  it("a return of an unused card on an invoiced sale takes it to $0 when it's booked, refunds it, and the day balances", async () => {
    await refundsCards(true);
    const order = await sold([sofaLine(), card("GC-RETURN", 100)]);
    const payment = await cash(order.id, 1160);
    // Delivered: the sale is invoiced after it was paid.
    await prisma.invoice.create({
      data: {
        invoiceNo: `INV-${order.id}`,
        invoiceDate: new Date(),
        taxAmount: 60,
        salesOrderId: order.id,
      },
    });
    const line = await cardLineOf(order.id);

    const started = await startReturn(order.id, line.id);
    expect(started.statusCode).toBe(201);
    await refundReturn(started.body.id, {
      destination: "ORIGINAL_PAYMENT",
      paymentId: payment.id,
      amount: 100,
      createdBy: ACTOR,
    });

    const after = await expectHistoryAddsUp("GC-RETURN");
    expect(Number(after.currentBalance)).toBe(0);
    expect(after.transactions.map((t) => [t.transactionType, Number(t.amount)])).toEqual([
      ["ISSUANCE", 100],
      ["REFUND", -100],
    ]);
    // The return's own line is a card line: it reverses no revenue.
    const ret = await prisma.return.findUniqueOrThrow({ where: { id: started.body.id } });
    const returnLine = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: ret.returnOrderId as number },
    });
    expect(returnLine.giftCardNumber).toBe("GC-RETURN");
    expect(Number(returnLine.netPrice)).toBe(-100);
    const refunds = await prisma.payment.findMany({ where: { isRefund: true } });
    expect(refunds.map((r) => Number(r.paymentAmount))).toEqual([100]);

    // Sold, delivered and returned in one day: the card nets out of 2-2127 and out of AR.
    const { marker } = await dayMarker();
    const je = await journalFor(marker);
    expect(creditsOn([je], gl.giftCards)).toBe(0);
    expect(creditsOn([je], gl.ar)).toBe(0);
    expect(creditsOn([je], gl.deposits)).toBe(0);
    expect(creditsOn([je], gl.sales)).toBe(1000);
    expect(creditsOn([je], gl.cash)).toBe(-1060);
  });

  it("a card on a sale not yet invoiced is cancelled, not returned", async () => {
    await refundsCards(true);
    const order = await sold([card("GC-NOINV", 100)]);
    await cash(order.id, 100);
    const line = await cardLineOf(order.id);

    const returned = await startReturn(order.id, line.id);
    expect(returned.statusCode).toBe(409);
    expect(returned.body.error).toContain("cancel its line instead");
  });
});
