// /app/__tests__/integration/storeTenders.integration.test.ts
//
// The payment types a store sets up for itself (lib/payments/tenders.ts):
// Settings makes one with its GL mapping; the register and the invoice screen
// take payments with it under its kind and name; a refund goes back to it;
// the till, the sales journal and the daily reconciliation all see it as the
// money it is. Real routes, real permission gate, real database; next-auth's
// session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({
  getServerSession: (...args: unknown[]) => jest.requireMock("next-auth").getServerSession(...args),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import {
  createTender,
  deleteTender,
  TenderError,
  updateTender,
  type TenderInput,
} from "@/lib/payments/tenders";
import { calculateTillExpected, processRefund, recordPayment } from "@/lib/paymentService";
import {
  createDraftInvoice,
  issueInvoice,
  recordInvoicePayment,
} from "@/lib/billing/invoiceService";
import { generateSalesJournal } from "@/lib/journalEntry";
import { resolveReconciliationAccounts } from "@/lib/dailyReconciliation";
import tendersRoute from "@/pages/api/tenders/index";
import paymentsRoute from "@/pages/api/sales/orders/[id]/payments";
import { posted } from "../helpers/postedJournal";

const sessionMock = getServerSession as jest.Mock;

// A journal covers a business day (America/New_York by default), so the
// payment is stamped at noon Eastern on the day the journal is generated for.
const DAY = new Date("2026-04-28T00:00:00Z");
const DAY_AT = new Date("2026-04-28T16:00:00Z");

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
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

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string>,
  body: unknown = {},
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method, query, body, cookies: {} } as any;
  await route(req, res);
  return res;
}

async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: roleKey as any, roleId: role.id },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

const tender = (input: TenderInput) =>
  prisma.$transaction((tx) => createTender(tx, input, "admin@example.com"));

async function newOrder() {
  const customer = await prisma.customer.create({ data: { firstName: "Pat", lastName: "Buyer" } });
  return prisma.salesOrder.create({
    data: {
      orderno: `SO-${customer.id}`,
      status: "ORDER",
      orderDate: DAY_AT,
      customerId: customer.id,
    },
  });
}

let gl: Record<"cash" | "finance" | "deposit" | "ar" | "revenue" | "tax" | "overShort", number>;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await makeStaff("admin", "ADMIN");
  await makeStaff("cass", "REGISTER");
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  const account = async (code: string, name: string, accountType: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await prisma.gLAccount.create({ data: { code, name, accountType: accountType as any } })).id;
  gl = {
    cash: await account("1-1006", "Cash", "ASSET"),
    finance: await account("1-1250", "Finance Receivable", "ASSET"),
    deposit: await account("2-2200", "Customer Deposits", "LIABILITY"),
    ar: await account("1-1100", "Accounts Receivable", "ASSET"),
    revenue: await account("4-4000", "Service Revenue", "REVENUE"),
    tax: await account("2-2120", "Sales Tax Payable", "LIABILITY"),
    overShort: await account("5-5900", "Cash Over/Short", "EXPENSE"),
  };
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "POS_PAYMENTS", label: "Cash", glAccountId: gl.cash },
      { section: "POS_PAYMENTS", label: "Wire", glAccountId: gl.cash },
      { section: "POS_PAYMENTS", label: "Finance", glAccountId: gl.finance },
      { section: "POS_PAYMENTS", label: "On Account", glAccountId: gl.deposit },
      { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: gl.tax },
      { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: gl.overShort },
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: gl.ar },
      { section: "AR_TRANSACTIONS", label: "Invoice Sales", glAccountId: gl.revenue },
      { section: "AR_TRANSACTIONS", label: "Sales Tax", glAccountId: gl.tax },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("setting up a payment type", () => {
  it("books to its kind's account from the start, and refuses a name a built-in or the deposit uses", async () => {
    await tender({ name: "Synchrony", kind: "FINANCE" });
    const mapping = await prisma.systemGLMapping.findUniqueOrThrow({
      where: { section_label: { section: "POS_PAYMENTS", label: "Synchrony" } },
    });
    expect(mapping.glAccountId).toBe(gl.finance);

    for (const name of ["cash", "Store Credit", "Deposit", "on account"]) {
      await expect(tender({ name, kind: "OTHER" })).rejects.toThrow(TenderError);
    }
    await expect(tender({ name: "synchrony", kind: "FINANCE" })).rejects.toThrow(
      'There is already a payment type named "synchrony".',
    );
    // A card, gift card, store credit or cash kind has machinery of its own.
    await expect(tender({ name: "House Card", kind: "CARD" })).rejects.toThrow(
      "A payment type is a Finance, Wire, ACH or Other kind.",
    );
    expect(await prisma.tender.count()).toBe(1);
  });

  it("fixes the name and kind once a payment uses it, and switches off instead of deleting", async () => {
    const used = await tender({ name: "Synchrony", kind: "FINANCE" });
    const order = await newOrder();
    await recordPayment(order.id, { method: "FINANCE", amount: 100, tenderId: used.id });

    const rename = prisma.$transaction((tx) => updateTender(tx, used.id, { name: "Sync" }, null));
    await expect(rename).rejects.toThrow("so its name and kind are fixed");
    const rekind = prisma.$transaction((tx) => updateTender(tx, used.id, { kind: "OTHER" }, null));
    await expect(rekind).rejects.toThrow("so its name and kind are fixed");
    await expect(prisma.$transaction((tx) => deleteTender(tx, used.id))).rejects.toThrow(
      "Switch it off instead",
    );
    const off = await prisma.$transaction((tx) =>
      updateTender(tx, used.id, { isActive: false, atRegister: false }, null),
    );
    expect(off).toMatchObject({ name: "Synchrony", isActive: false, atRegister: false });

    // Unused: renamed with its mapping, then deleted with it.
    const spare = await tender({ name: "Zell", kind: "OTHER" });
    await prisma.$transaction((tx) => updateTender(tx, spare.id, { name: "Zelle" }, null));
    const labels = async () =>
      (await prisma.systemGLMapping.findMany({ where: { section: "POS_PAYMENTS" } })).map(
        (m) => m.label,
      );
    expect(await labels()).toEqual(expect.arrayContaining(["Zelle", "Synchrony"]));
    expect(await labels()).not.toContain("Zell");
    await prisma.$transaction((tx) => deleteTender(tx, spare.id));
    expect(await labels()).not.toContain("Zelle");
    expect(await labels()).toContain("Synchrony");
  });
});

describe("taking a payment with one", () => {
  it("records the tender's kind and name whatever method was sent, with the reference", async () => {
    const synchrony = await tender({ name: "Synchrony", kind: "FINANCE", referenceRequired: true });
    const order = await newOrder();

    await expect(
      recordPayment(order.id, { method: "FINANCE", amount: 500, tenderId: synchrony.id }),
    ).rejects.toThrow("Enter the Synchrony reference");

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 500,
      tenderId: synchrony.id,
      reference: "  APP-7731 ",
    });
    expect(payment).toMatchObject({
      method: "FINANCE",
      paymentType: "Synchrony",
      tenderId: synchrony.id,
      reference: "APP-7731",
      status: "COMPLETED",
    });

    await prisma.tender.update({ where: { id: synchrony.id }, data: { isActive: false } });
    await expect(
      recordPayment(order.id, {
        method: "FINANCE",
        amount: 10,
        tenderId: synchrony.id,
        reference: "X",
      }),
    ).rejects.toThrow('"Synchrony" is switched off');
  });

  it("refunds back to the same tender", async () => {
    const zelle = await tender({ name: "Zelle", kind: "OTHER" });
    const order = await newOrder();
    const payment = await recordPayment(order.id, {
      method: "OTHER",
      amount: 80,
      tenderId: zelle.id,
    });

    const refund = await processRefund(payment.id, { amount: 30, reason: "Damaged" });
    expect(refund).toMatchObject({
      isRefund: true,
      status: "COMPLETED",
      method: "OTHER",
      paymentType: "Zelle",
      tenderId: zelle.id,
    });
  });

  it("takes an invoice payment with one, and keeps a wire's reference", async () => {
    const synchrony = await tender({ name: "Synchrony", kind: "FINANCE" });
    const customer = await prisma.customer.create({ data: { firstName: "Ivy", lastName: "Test" } });
    const { id } = await createDraftInvoice({
      customerId: customer.id,
      lines: [{ description: "Work", quantity: 1, unitPrice: 1000 }],
    });
    await issueInvoice(id, "test@holt");

    await expect(
      recordInvoicePayment(id, { amount: 10, method: "CASH", tenderId: synchrony.id }),
    ).rejects.toThrow("Choose one payment method.");

    const viaTender = await recordInvoicePayment(id, {
      amount: 600,
      tenderId: synchrony.id,
      reference: "APP-1",
    });
    const viaWire = await recordInvoicePayment(id, {
      amount: 400,
      method: "WIRE",
      reference: "WX-9",
    });
    const rows = await prisma.payment.findMany({
      where: { id: { in: [viaTender.paymentId, viaWire.paymentId] } },
      orderBy: { id: "asc" },
    });
    expect(rows.map((p) => [p.paymentType, p.method, p.tenderId, p.reference])).toEqual([
      ["Synchrony", "FINANCE", synchrony.id, "APP-1"],
      // Dropped before Payment.reference: only a check kept its reference.
      ["Wire", "WIRE", null, "WX-9"],
    ]);
  });
});

describe("the payments route", () => {
  it("records a tender payment and never takes processor ids from the browser", async () => {
    const zelle = await tender({ name: "Zelle", kind: "OTHER" });
    const order = await newOrder();
    signInAs("cass");

    const viaTender = await call(
      paymentsRoute,
      "POST",
      { id: String(order.id) },
      { method: "OTHER", amount: "25", tenderId: String(zelle.id), reference: "Z-1" },
    );
    expect(viaTender.statusCode).toBe(201);
    expect(viaTender.body.payment).toMatchObject({ paymentType: "Zelle", reference: "Z-1" });

    // A fabricated processor payment would refund through the processor, onto
    // whichever card the charge id names.
    const forged = await call(
      paymentsRoute,
      "POST",
      { id: String(order.id) },
      { method: "CARD", amount: "50", processorType: "STRIPE", processorTxnId: "pi_someone_else" },
    );
    expect(forged.statusCode).toBe(201);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: forged.body.payment.id } });
    expect([row.processorType, row.processorTxnId]).toEqual([null, null]);
    const refund = await processRefund(row.id, { amount: 50 });
    expect(refund.status).toBe("COMPLETED");
  });
});

describe("the tender list", () => {
  it("gives the register its active register tenders, and keeps Settings to admin.settings", async () => {
    await tender({ name: "Synchrony", kind: "FINANCE", referenceRequired: true, sortOrder: 1 });
    await tender({ name: "Zelle", kind: "OTHER", sortOrder: 0 });
    await tender({ name: "Invoice Only", kind: "WIRE", atRegister: false });
    await tender({ name: "Retired", kind: "OTHER", isActive: false });

    signInAs("cass");
    const offered = await call(tendersRoute, "GET", { for: "register" });
    expect(offered.statusCode).toBe(200);
    expect(offered.body.map((t: { name: string }) => t.name)).toEqual(["Zelle", "Synchrony"]);
    expect(offered.body[1]).toEqual({
      id: expect.any(Number),
      name: "Synchrony",
      kind: "FINANCE",
      referenceRequired: true,
    });
    expect((await call(tendersRoute, "GET", {})).statusCode).toBe(403);
    expect(
      (await call(tendersRoute, "POST", {}, { name: "Venmo", kind: "OTHER" })).statusCode,
    ).toBe(403);

    signInAs("admin");
    const all = await call(tendersRoute, "GET", {});
    expect(all.statusCode).toBe(200);
    expect(all.body).toHaveLength(4);
    expect(all.body.find((t: { name: string }) => t.name === "Synchrony")).toMatchObject({
      paymentCount: 0,
      glAccount: { code: "1-1250", name: "Finance Receivable" },
    });
    const made = await call(tendersRoute, "POST", {}, { name: "Venmo", kind: "OTHER" });
    expect(made.statusCode).toBe(201);
    const refused = await call(tendersRoute, "POST", {}, { name: "Cash", kind: "OTHER" });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("is a built-in payment type");
  });
});

describe("where the money is reported", () => {
  it("the till shows each tender under its own name, outside the drawer", async () => {
    const cass = await prisma.staffMember.findFirstOrThrow({ where: { userId: "cass" } });
    const store = await prisma.storeLocation.create({
      data: { name: "Main", code: "MAIN", type: "STORE" },
    });
    const register = await prisma.register.create({
      data: { name: "Front", storeLocationId: store.id },
    });
    const till = await prisma.till.create({
      data: { registerId: register.id, status: "OPEN", openedById: cass.id, openingCash: 100 },
    });
    const synchrony = await tender({ name: "Synchrony", kind: "FINANCE" });
    const zelle = await tender({ name: "Zelle", kind: "OTHER" });
    const order = await newOrder();
    const at = { tillId: till.id };
    await recordPayment(order.id, { method: "CASH", amount: 40, ...at });
    await recordPayment(order.id, {
      method: "FINANCE",
      amount: 900,
      tenderId: synchrony.id,
      ...at,
    });
    await recordPayment(order.id, { method: "OTHER", amount: 60, tenderId: zelle.id, ...at });

    const expected = await calculateTillExpected(till.id);
    expect(expected.expectedCash).toBe(140);
    expect(expected.other).toBe(960);
    expect(expected.otherByType).toEqual([
      { label: "Synchrony", amount: 900 },
      { label: "Zelle", amount: 60 },
    ]);
  });

  it("the sales journal debits the tender's account, with nothing unmapped", async () => {
    const synchrony = await tender({ name: "Synchrony", kind: "FINANCE" });
    const order = await newOrder();
    const payment = await recordPayment(order.id, {
      method: "FINANCE",
      amount: 750,
      tenderId: synchrony.id,
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { paymentDate: DAY_AT } });

    const result = await generateSalesJournal(DAY);
    expect(result.warnings.filter((w) => w.includes("Unmapped"))).toEqual([]);
    const byCode = new Map(posted(result).lines.map((l) => [l.glAccount?.code, l]));
    expect(byCode.get("1-1250")?.debit).toBe(750);
    expect(byCode.get("2-2200")?.credit).toBe(750);
  });

  it("the reconciliation counts a tender's own account as money received", async () => {
    await tender({ name: "Synchrony", kind: "FINANCE" });
    const own = await prisma.gLAccount.create({
      data: { code: "1-1260", name: "Synchrony Receivable", accountType: "ASSET" },
    });
    await prisma.systemGLMapping.update({
      where: { section_label: { section: "POS_PAYMENTS", label: "Synchrony" } },
      data: { glAccountId: own.id },
    });

    const accounts = await resolveReconciliationAccounts(prisma);
    expect(accounts.cash.has(own.id)).toBe(true);
    // The deposit offset shares the section and is not tender.
    expect(accounts.cash.has(gl.deposit)).toBe(false);
  });
});
