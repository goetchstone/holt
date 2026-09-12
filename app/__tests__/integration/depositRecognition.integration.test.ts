// /app/__tests__/integration/depositRecognition.integration.test.ts
//
// THE POLICY, AS ACCOUNTING:
//
//   Anything not delivered is a promise, not a sale. Reports and dashboards may
//   show it as sales data, but in accounting it sits in customer deposits and
//   liabilities until delivered. Delivery generates the invoice, which moves the
//   money OUT of deposits and makes the journal entries for sales and tax.
//
// The furniture case is a deposit now and delivery weeks later, so the two legs
// land in DIFFERENT journals. That is the whole difficulty: the deposit is
// credited to the liability in one period and has to be debited back out in
// another, and nothing in a single-period test can see whether that happens.
//
// It did not happen. The recognition journal credited revenue for the full order
// while debiting only the cash it saw that day, and the balancer put the missing
// deposit into Cash Over/Short. Two consequences, both silent because a plugged
// entry still balances:
//
//   - Customer Deposits was never relieved, so the liability grew forever and
//     the balance sheet carried money the business no longer owed.
//   - The P&L carried a fake Over/Short equal to every deposit ever recognised.
//
// The assertion that matters most is the last one: across both periods the
// deposit account nets to zero. That is the policy stated as arithmetic.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { recordPayment } from "@/lib/paymentService";
import { generateSalesJournal } from "@/lib/journalEntry";
import { posted } from "../helpers/postedJournal";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { businessDayKey } from "@/lib/reports/businessDay";

const ORDER_TOTAL = 3000;
const ORDER_COST = 1500;
const DEPOSIT = 1200;
const BALANCE = ORDER_TOTAL - DEPOSIT;

const NOW = new Date();
const EARLIER = new Date(NOW.getTime() - 40 * 86_400_000);

const CASH = "1-1006";
const DEPOSITS = "2-2200";
const SALES = "4-4080";
const COGS = "5-5280";
const INVENTORY = "1-1380";
const OVER_SHORT = "5-5900";

interface Posted {
  debit(code: string): number;
  credit(code: string): number;
  balanced: boolean;
}

async function postDay(date: Date): Promise<Posted> {
  const result = await generateSalesJournal(date, "deposit-recognition-test");
  const entry = await prisma.journalEntry.findUniqueOrThrow({
    where: { id: posted(result).id },
    include: { lines: { include: { glAccount: true } } },
  });
  const sum = (code: string, side: "debit" | "credit") =>
    entry.lines
      .filter((l) => l.glAccount?.code === code)
      .reduce((s, l) => s + Number(l[side] ?? 0), 0);
  const debits = entry.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const credits = entry.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  return {
    debit: (c) => sum(c, "debit"),
    credit: (c) => sum(c, "credit"),
    balanced: Math.abs(debits - credits) < 0.005,
  };
}

describe("a deposit becomes revenue only on delivery (real DB)", () => {
  let day1: Date;
  let day2: Date;
  let orderId: number;

  beforeAll(async () => {
    await resetTestDb();
    const timeZone = await getBusinessTimeZone();
    day1 = new Date(`${businessDayKey(EARLIER, timeZone)}T00:00:00Z`);
    day2 = new Date(`${businessDayKey(NOW, timeZone)}T00:00:00Z`);

    const gl = (code: string, name: string, accountType: string) =>
      prisma.gLAccount.create({ data: { code, name, accountType } });
    const cash = await gl(CASH, "Cash", "ASSET");
    const deposits = await gl(DEPOSITS, "Customer Deposits", "LIABILITY");
    const sales = await gl(SALES, "Furniture Sales", "REVENUE");
    const cogs = await gl(COGS, "Furniture COGS", "EXPENSE");
    const inventory = await gl(INVENTORY, "Furniture Inventory", "ASSET");
    const overShort = await gl(OVER_SHORT, "Cash Over/Short", "EXPENSE");
    const shrinkage = await gl("5-5010", "Shrinkage", "EXPENSE");
    const salesTax = await gl("2-2120", "Sales Tax Payable", "LIABILITY");

    await prisma.systemGLMapping.createMany({
      data: [
        { section: "POS_PAYMENTS", label: "Cash", glAccountId: cash.id },
        // The deposit offset. This mapping is what the recognition journal has
        // to debit back out when the sale is finally recognised.
        { section: "POS_PAYMENTS", label: "On Account", glAccountId: deposits.id },
        { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: overShort.id },
        { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: salesTax.id },
      ],
    });

    const accountGroup = await prisma.accountGroup.create({
      data: {
        name: "Furniture",
        salesAccountId: sales.id,
        cogsAccountId: cogs.id,
        inventoryAccountId: inventory.id,
        shrinkageAccountId: shrinkage.id,
      },
    });
    const vendor = await prisma.vendor.create({
      data: { name: "Northfield", code: "NF", pricingModel: "FLAT" },
    });
    const department = await prisma.department.create({ data: { name: "Living Room" } });
    const category = await prisma.category.create({
      data: { name: "Sofas", departmentId: department.id, accountGroupId: accountGroup.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "NF-SOFA",
        name: "Northfield Sofa",
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { firstName: "Marion", lastName: "Webb" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-DEPOSIT-1",
        status: "ORDER",
        orderDate: EARLIER,
        customerId: customer.id,
        storeLocation: "Main Street",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: product.id,
              productName: "Northfield Sofa",
              orderedQuantity: 1,
              netPrice: ORDER_TOTAL,
              cost: ORDER_COST,
              vatRate: 0,
              vatAmount: 0,
            },
          ],
        },
      },
    });
    orderId = order.id;

    // The deposit, taken weeks before delivery. recordPayment stamps the date
    // itself, so it is backdated here -- the two legs MUST land in different
    // journals or the cross-period behaviour is invisible.
    const deposit = await recordPayment(orderId, {
      method: "CASH",
      amount: DEPOSIT,
      customerId: customer.id,
    });
    await prisma.payment.update({
      where: { id: deposit.id },
      data: { paymentDate: EARLIER },
    });
  });

  it("the order period parks the deposit in the liability, recognising nothing", async () => {
    const day = await postDay(day1);

    expect(day.debit(CASH)).toBe(DEPOSIT);
    expect(day.credit(DEPOSITS)).toBe(DEPOSIT);

    // A promise, not a sale: no revenue, no COGS, no inventory relief.
    expect(day.credit(SALES)).toBe(0);
    expect(day.debit(COGS)).toBe(0);
    expect(day.credit(INVENTORY)).toBe(0);
    expect(day.balanced).toBe(true);
  });

  it("the delivery period recognises the sale and RELIEVES the deposit", async () => {
    // Delivered, so it is invoiced, and the balance is settled on the day.
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-DEPOSIT-1",
        invoiceDate: NOW,
        taxAmount: 0,
        total: ORDER_TOTAL,
        salesOrderId: orderId,
        status: "ISSUED",
      },
    });
    await recordPayment(orderId, { method: "CASH", amount: BALANCE });

    const day = await postDay(day2);

    // The sale, recognised in full now that the goods have gone.
    expect(day.credit(SALES)).toBe(ORDER_TOTAL);
    expect(day.debit(COGS)).toBe(ORDER_COST);
    expect(day.credit(INVENTORY)).toBe(ORDER_COST);

    // Only today's money is cash.
    expect(day.debit(CASH)).toBe(BALANCE);

    // AND THE POINT: the deposit taken weeks ago is debited back out. Without
    // this the entry is short by exactly the deposit, and the balancer hides
    // the difference in Over/Short.
    expect(day.debit(DEPOSITS)).toBe(DEPOSIT);

    // Which means the plug is untouched. Over/Short reports till discrepancies;
    // a deposit being recognised on schedule is not one.
    expect(day.debit(OVER_SHORT) + day.credit(OVER_SHORT)).toBe(0);
    expect(day.balanced).toBe(true);
  });

  it("an order paid in two instalments is recognised ONCE, on the delivery day", async () => {
    // The other half of keying recognition to payments: `processedOrders` is
    // per-call, so an invoiced order was booked again every day it received
    // money -- revenue credited twice for one sale, inventory relieved twice,
    // and the plug hiding the difference both times.
    //
    // Day 1 above already recognised nothing (no invoice) and day 2 recognised
    // once. Re-generating day 1 must STILL recognise nothing, because the
    // invoice is not dated then -- the deposit payment on that day cannot drag
    // the sale into it.
    await prisma.journalEntry.deleteMany({});
    const first = await postDay(day1);
    expect(first.credit(SALES)).toBe(0);
    expect(first.debit(COGS)).toBe(0);
    expect(first.credit(DEPOSITS)).toBe(DEPOSIT);
    expect(first.balanced).toBe(true);

    const second = await postDay(day2);
    expect(second.credit(SALES)).toBe(ORDER_TOTAL);
    expect(second.debit(DEPOSITS)).toBe(DEPOSIT);
    expect(second.balanced).toBe(true);

    // Across every journal that exists, the sale is credited exactly once.
    const salesLines = await prisma.journalEntryLine.findMany({
      where: { glAccount: { code: SALES } },
      select: { credit: true },
    });
    const totalRecognised = salesLines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0);
    expect(totalRecognised).toBe(ORDER_TOTAL);
  });

  it("across both periods the deposit account nets to zero", async () => {
    // The policy stated as arithmetic. The business held the customer's money
    // while it owed them a sofa, and stopped holding it when the sofa arrived.
    // If this is non-zero, the balance sheet carries money nobody is owed.
    const lines = await prisma.journalEntryLine.findMany({
      where: { glAccount: { code: DEPOSITS } },
      select: { debit: true, credit: true },
    });
    const net = lines.reduce((sum, l) => sum + Number(l.credit ?? 0) - Number(l.debit ?? 0), 0);
    expect(net).toBe(0);
  });
});
