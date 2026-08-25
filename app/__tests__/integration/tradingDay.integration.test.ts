// /app/__tests__/integration/tradingDay.integration.test.ts
//
// ONE TRADING DAY, END TO END, AGAINST A REAL DATABASE.
//
// Every segment below already had integration coverage before this file
// existed. What had none were the SEAMS between them -- the places where one
// subsystem's output becomes another's input. Those were covered by me reading
// the code and concluding it lined up, which is not coverage.
//
// The day, in order:
//
//    open till -> sell (split tender deposit) -> raise PO against the order
//    -> receive PO into stock -> allocate to the order -> move it between
//    stock locations -> schedule the delivery -> complete the delivery
//    -> settle the balance -> close the till -> post the journal
//    -> reconcile the day
//
// The assertions that matter are the ones ACROSS a seam, not within a stage:
//
//    - stock received against a PO becomes stock the allocator can see
//    - stock allocated to an order stops being free to sell to anyone else
//    - moving allocated stock between locations keeps it allocated
//      (a transfer that orphans allocation shows as free stock reappearing)
//    - completing the delivery consumes the allocation and leaves NO residue:
//      not free, not allocated, gone
//    - the day's payments reach the journal, and the journal balances
//    - reconciliation over the same day reports no drift
//
// Stage order is the point, so these are ordered `it`s over shared state
// rather than independent cases. A failure names the stage the day broke at.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { recordPayment, calculateOrderBalance } from "@/lib/paymentService";
import { allocate, consume, availableQuantity } from "@/lib/inventory/allocation";
import { generateSalesJournal, transitionJournalEntry } from "@/lib/journalEntry";
import { computeDailyReconciliation } from "@/lib/dailyReconciliation";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { createDraftInvoice, issueInvoice } from "@/lib/billing/invoiceService";
import { businessDayKey } from "@/lib/reports/businessDay";

// The trading day is TODAY, and that is deliberate rather than lazy.
// recordPayment() stamps paymentDate itself -- there is no way to inject one,
// which is correct for a till but means a backdated test day would record its
// payments outside the window the journal then reads. Pinning a fixed date
// would have produced a test that passes while proving nothing, because the
// journal would find no payments and the reconciliation would compare two
// empty sets and call them equal.
//
// DAY is resolved through businessDayKey() in the BUSINESS timezone, not UTC.
// The journal reads getBusinessTimeZone() internally; if this test picked the
// day a different way, the two would disagree near midnight and the failure
// would look like drift rather than a timezone bug.
const TRADING_HOUR = new Date();
let DAY: Date;
let TIME_ZONE: string;

const SOFA_PRICE = 2400;
const CHAIR_PRICE = 600;
const ORDER_TOTAL = SOFA_PRICE + CHAIR_PRICE; // 3000, tax-free for arithmetic clarity
const DEPOSIT_CASH = 500;
const DEPOSIT_CARD = 700;
const DEPOSIT_TOTAL = DEPOSIT_CASH + DEPOSIT_CARD; // 1200
const BALANCE_ON_DELIVERY = ORDER_TOTAL - DEPOSIT_TOTAL; // 1800
const OPENING_CASH = 200;

const world: Record<string, any> = {};

beforeAll(async () => {
  await resetTestDb();

  // Self-hosted deployments run a single org (appSettings.DEFAULT_ORG_ID = 1)
  // and invoicing writes to it, so the row has to exist before the day starts.
  await prisma.organization.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: "Holt Demo", slug: "holt-demo" },
  });

  TIME_ZONE = await getBusinessTimeZone();
  DAY = new Date(`${businessDayKey(TRADING_HOUR, TIME_ZONE)}T00:00:00Z`);

  // ---- accounting config (deployment config, not code) ----
  const gl = async (code: string, name: string, accountType: string) =>
    prisma.gLAccount.create({ data: { code, name, accountType } });

  const cash = await gl("1-1006", "Cash", "ASSET");
  const card = await gl("1-1010", "Card Clearing", "ASSET");
  const deposits = await gl("2-2200", "Customer Deposits", "LIABILITY");
  const sales = await gl("4-4080", "Furniture Sales", "REVENUE");
  const cogs = await gl("5-5280", "Furniture COGS", "EXPENSE");
  const inventory = await gl("1-1380", "Furniture Inventory", "ASSET");
  const overShort = await gl("5-5900", "Cash Over/Short", "EXPENSE");
  const receivable = await gl("1-1100", "Accounts Receivable", "ASSET");
  const salesTax = await gl("2-2120", "Sales Tax Payable", "LIABILITY");
  const shrinkage = await gl("5-5010", "Furniture Shrinkage", "EXPENSE");

  await prisma.systemGLMapping.createMany({
    data: [
      { section: "POS_PAYMENTS", label: "Cash", glAccountId: cash.id },
      { section: "POS_PAYMENTS", label: "Card", glAccountId: card.id },
      { section: "POS_PAYMENTS", label: "On Account", glAccountId: deposits.id },
      { section: "POS_TRANSACTIONS", label: "Over/Short", glAccountId: overShort.id },
      // The day is deliberately tax-free so the arithmetic stays legible, but
      // the mapping still has to exist: computeDailyReconciliation() reports
      // `balanced: false` on an INCOMPLETE configuration even when nothing has
      // drifted, on the grounds that a reconciliation it cannot fully compute
      // should not claim the books tie out.
      { section: "POS_TRANSACTIONS", label: "Sales Tax", glAccountId: salesTax.id },
      // Invoicing posts through its own section; issueInvoice() refuses
      // without these rather than posting to nowhere.
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: receivable.id },
      { section: "AR_TRANSACTIONS", label: "Invoice Sales", glAccountId: sales.id },
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

  // ---- the store ----
  world.store = await prisma.storeLocation.create({
    data: { name: "Main Street", code: "MAIN", type: "STORE" },
  });
  world.backroom = await prisma.stockLocation.create({
    data: {
      storeLocationId: world.store.id,
      code: "BACK",
      name: "Backroom",
      locationType: "STOCK",
    },
  });
  world.warehouse = await prisma.stockLocation.create({
    data: {
      storeLocationId: world.store.id,
      code: "WHSE",
      name: "Warehouse",
      locationType: "STOCK",
    },
  });

  // ---- catalogue ----
  const vendor = await prisma.vendor.create({
    data: { name: "Northfield Upholstery", code: "NFU", pricingModel: "FLAT" },
  });
  world.vendor = vendor;
  const department = await prisma.department.create({ data: { name: "Living Room" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, accountGroupId: accountGroup.id },
  });
  world.sofa = await prisma.product.create({
    data: {
      productNumber: "NFU-SOFA-01",
      name: "Northfield Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  world.chair = await prisma.product.create({
    data: {
      productNumber: "NFU-CHAIR-01",
      name: "Northfield Accent Chair",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });

  // ---- people ----
  world.user = await prisma.user.create({
    data: { email: "clerk@example.test", name: "Day Clerk" },
  });
  world.clerk = await prisma.staffMember.create({
    data: { displayName: "Day Clerk", isActive: true },
  });
  world.driver = await prisma.staffMember.create({
    data: { displayName: "Delivery Driver", isActive: true },
  });
  world.vehicle = await prisma.vehicle.create({ data: { name: "Box Truck 1" } });
  world.register = await prisma.register.create({
    data: { name: "Front Register", storeLocationId: world.store.id },
  });
});

describe("a complete trading day (real DB)", () => {
  it("1. opens the till", async () => {
    world.till = await prisma.till.create({
      data: {
        registerId: world.register.id,
        openedById: world.clerk.id,
        openingCash: OPENING_CASH,
        openedAt: TRADING_HOUR,
        status: "OPEN",
      },
    });
    expect(world.till.status).toBe("OPEN");
    expect(Number(world.till.openingCash)).toBe(OPENING_CASH);
  });

  it("2. sells a sofa and a chair to a walk-in customer", async () => {
    world.customer = await prisma.customer.create({
      data: { firstName: "Marion", lastName: "Webb" },
    });
    world.order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-TRADING-DAY-1",
        status: "ORDER",
        orderDate: TRADING_HOUR,
        customerId: world.customer.id,
        storeLocation: world.store.name,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: world.sofa.id,
              productName: world.sofa.name,
              orderedQuantity: 1,
              netPrice: SOFA_PRICE,
              cost: SOFA_PRICE / 2,
              vatRate: 0,
              vatAmount: 0,
            },
            {
              lineNumber: 2,
              productId: world.chair.id,
              productName: world.chair.name,
              orderedQuantity: 1,
              netPrice: CHAIR_PRICE,
              cost: CHAIR_PRICE / 2,
              vatRate: 0,
              vatAmount: 0,
            },
          ],
        },
      },
    });

    const balance = await calculateOrderBalance(world.order.id);
    expect(balance.totalDue).toBe(ORDER_TOTAL);
    expect(balance.balanceDue).toBe(ORDER_TOTAL);
  });

  it("3. takes a split-tender deposit and leaves the exact balance owing", async () => {
    await recordPayment(world.order.id, {
      method: "CASH",
      amount: DEPOSIT_CASH,
      registerId: world.register.id,
      tillId: world.till.id,
      staffMemberId: world.clerk.id,
      customerId: world.customer.id,
    });
    await recordPayment(world.order.id, {
      method: "CARD",
      amount: DEPOSIT_CARD,
      registerId: world.register.id,
      tillId: world.till.id,
      staffMemberId: world.clerk.id,
      customerId: world.customer.id,
      cardLast4: "4242",
      cardBrand: "VISA",
    });

    const balance = await calculateOrderBalance(world.order.id);
    expect(balance.totalPaid).toBe(DEPOSIT_TOTAL);
    expect(balance.balanceDue).toBe(BALANCE_ON_DELIVERY);

    // SEAM: the payment must have appended a ledger entry in the SAME
    // transaction. lib/customerArDrift.ts exists to detect the absence of this;
    // if it can drift, the AR report is fiction.
    const ledger = await prisma.customerLedgerEntry.findMany({
      where: { customerId: world.customer.id },
    });
    expect(ledger.length).toBeGreaterThanOrEqual(2);
  });

  it("4. raises a purchase order against the customer's order", async () => {
    world.po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-TRADING-DAY-1",
        vendorId: world.vendor.id,
        salesOrderId: world.order.id, // the link that makes this a special order
        orderDate: TRADING_HOUR,
        status: "SUBMITTED",
        lineItems: {
          create: [
            { productId: world.sofa.id, orderedQuantity: 1, unitCost: SOFA_PRICE / 2 },
            { productId: world.chair.id, orderedQuantity: 1, unitCost: CHAIR_PRICE / 2 },
          ],
        },
      },
      include: { lineItems: true },
    });

    expect(world.po.salesOrderId).toBe(world.order.id);
    expect(world.po.lineItems).toHaveLength(2);

    // Nothing is sellable yet -- the goods have not arrived.
    const free = await availableQuantity(world.sofa.id, world.store.id, prisma);
    expect(free).toBe(0);
  });

  it("5. receives the PO into stock, and the allocator can see it", async () => {
    for (const line of world.po.lineItems) {
      await prisma.receivingRecord.create({
        data: {
          purchaseOrderId: world.po.id,
          purchaseOrderItemId: line.id,
          quantityReceived: 1,
          receivedDate: TRADING_HOUR,
          receiverUserId: world.user.id,
          destinationLocationId: world.store.id,
          destinationStockLocationId: world.warehouse.id,
          condition: "OK",
        },
      });
      await prisma.inventoryPosition.create({
        data: {
          productId: line.productId!,
          storeLocationId: world.store.id,
          stockLocationId: world.warehouse.id,
          quantity: 1,
        },
      });
    }
    await prisma.purchaseOrder.update({
      where: { id: world.po.id },
      data: { status: "RECEIVED_FULL" },
    });

    // SEAM: received goods are goods the allocator can allocate.
    expect(await availableQuantity(world.sofa.id, world.store.id, prisma)).toBe(1);
    expect(await availableQuantity(world.chair.id, world.store.id, prisma)).toBe(1);
  });

  it("6. allocates the stock to the order, which stops it being free", async () => {
    const result = await prisma.$transaction((tx) =>
      allocate(
        world.order.id,
        [
          { productId: world.sofa.id, storeLocationId: world.store.id, quantity: 1 },
          { productId: world.chair.id, storeLocationId: world.store.id, quantity: 1 },
        ],
        tx,
      ),
    );

    expect(result.shortfalls).toHaveLength(0);

    // SEAM: allocated stock is no longer sellable to the next customer.
    // If this returns 1, two customers can be sold the same sofa.
    expect(await availableQuantity(world.sofa.id, world.store.id, prisma)).toBe(0);
    expect(await availableQuantity(world.chair.id, world.store.id, prisma)).toBe(0);

    const held = await prisma.inventoryPosition.findMany({
      where: { salesOrderId: world.order.id },
    });
    expect(held).toHaveLength(2);
    expect(held.every((p) => Number(p.quantity) === 1)).toBe(true);
  });

  it("7. moves the allocated stock to the backroom without orphaning it", async () => {
    const before = await prisma.inventoryPosition.findMany({
      where: { salesOrderId: world.order.id, stockLocationId: world.warehouse.id },
    });
    expect(before).toHaveLength(2);

    await prisma.$transaction(async (tx) => {
      for (const pos of before) {
        await tx.inventoryTransfer.create({
          data: {
            productId: pos.productId,
            quantity: Number(pos.quantity),
            fromLocation: world.warehouse.code,
            toLocation: world.backroom.code,
            fromStockLocationId: world.warehouse.id,
            toStockLocationId: world.backroom.id,
            salesOrderId: world.order.id,
            requestedByUserId: world.user.id,
            status: "RECEIVED",
          },
        });
        await tx.inventoryPosition.update({
          where: { id: pos.id },
          data: { stockLocationId: world.backroom.id },
        });
      }
    });

    // SEAM: a transfer must move stock, not duplicate or free it. If the
    // allocation were dropped on the move, free stock would reappear here and
    // the sofa could be sold to somebody else while it sits waiting to go out.
    expect(await availableQuantity(world.sofa.id, world.store.id, prisma)).toBe(0);
    const after = await prisma.inventoryPosition.findMany({
      where: { salesOrderId: world.order.id },
    });
    expect(after).toHaveLength(2);
    expect(after.every((p) => p.stockLocationId === world.backroom.id)).toBe(true);
  });

  it("8. schedules the delivery", async () => {
    world.appointment = await prisma.serviceAppointment.create({
      data: {
        appointmentNumber: "APPT-TRADING-DAY-1",
        type: "DELIVERY",
        status: "SCHEDULED",
        salesOrderId: world.order.id,
        customerId: world.customer.id,
        storeLocationId: world.store.id,
        scheduledDate: TRADING_HOUR,
      },
    });
    world.run = await prisma.deliveryRun.create({
      data: {
        runNumber: "RUN-TRADING-DAY-1",
        runDate: DAY,
        vehicleId: world.vehicle.id,
        driverId: world.driver.id,
        status: "PLANNING",
      },
    });
    world.stop = await prisma.deliveryStop.create({
      data: {
        deliveryRunId: world.run.id,
        serviceAppointmentId: world.appointment.id,
        stopOrder: 1,
        status: "PENDING",
      },
    });

    // SEAM: the stop is reachable from the order, which is what "track every
    // step" means -- one query from the customer's order to the truck.
    const traced = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: world.order.id },
      include: { serviceAppointments: { include: { deliveryStop: true } } },
    });
    expect(traced.serviceAppointments[0].deliveryStop?.id).toBe(world.stop.id);
  });

  it("9. completes the delivery and consumes the allocation with no residue", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.deliveryStop.update({
        where: { id: world.stop.id },
        data: { status: "COMPLETED", completedAt: TRADING_HOUR, recipientName: "M. Webb" },
      });
      await tx.deliveryRun.update({
        where: { id: world.run.id },
        data: { status: "COMPLETED", completedAt: TRADING_HOUR },
      });
      await tx.serviceAppointment.update({
        where: { id: world.appointment.id },
        data: { status: "COMPLETED", completedAt: TRADING_HOUR },
      });
      await consume(
        world.order.id,
        [
          { productId: world.sofa.id, quantity: 1 },
          { productId: world.chair.id, quantity: 1 },
        ],
        tx,
      );
    });

    // SEAM: goods that left the building are gone. Not free stock (it would be
    // sold twice), not allocated stock (the balance sheet would carry a sofa
    // that is in somebody's living room).
    expect(await availableQuantity(world.sofa.id, world.store.id, prisma)).toBe(0);
    const residue = await prisma.inventoryPosition.findMany({
      where: { productId: { in: [world.sofa.id, world.chair.id] } },
    });
    expect(residue).toHaveLength(0);
  });

  it("10. invoices the customer on delivery", async () => {
    const { id: invoiceId } = await createDraftInvoice({
      customerId: world.customer.id,
      // The link that turns a deposit into revenue: generateSalesJournal()
      // recognises an order only when it has an invoice attached.
      salesOrderId: world.order.id,
      lines: [
        { description: world.sofa.name, quantity: 1, unitPrice: SOFA_PRICE },
        { description: world.chair.name, quantity: 1, unitPrice: CHAIR_PRICE },
      ],
      taxRate: 0,
      createdBy: "trading-day-test",
    });
    await issueInvoice(invoiceId, "trading-day-test");
    world.invoiceId = invoiceId;

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("ISSUED");
    expect(Number(invoice.total)).toBe(ORDER_TOTAL);
    expect(invoice.salesOrderId).toBe(world.order.id);
  });

  it("11. settles the balance on delivery, to the cent", async () => {
    await recordPayment(world.order.id, {
      method: "CASH",
      amount: BALANCE_ON_DELIVERY,
      registerId: world.register.id,
      tillId: world.till.id,
      staffMemberId: world.clerk.id,
      customerId: world.customer.id,
    });

    const balance = await calculateOrderBalance(world.order.id);
    expect(balance.totalPaid).toBe(ORDER_TOTAL);
    expect(balance.balanceDue).toBe(0);

    // SEAM: the customer's AR position closes with the order. A balance that
    // settles on the order but not on the customer is the drift that makes an
    // aging report untrustworthy.
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: world.customer.id },
    });
    expect(Number(customer.openArBalance ?? 0)).toBe(0);
  });

  it("12. closes the till against the cash actually taken", async () => {
    const cashTaken = DEPOSIT_CASH + BALANCE_ON_DELIVERY; // 2300
    const expectedCash = OPENING_CASH + cashTaken;

    const payments = await prisma.payment.aggregate({
      where: { tillId: world.till.id, method: "CASH" },
      _sum: { paymentAmount: true },
    });
    // SEAM: the till knows what the register rang. If this disagrees, every
    // cash variance downstream is measuring the wrong thing.
    expect(Number(payments._sum?.paymentAmount ?? 0)).toBe(cashTaken);

    world.till = await prisma.till.update({
      where: { id: world.till.id },
      data: {
        status: "CLOSED",
        closedAt: TRADING_HOUR,
        closedById: world.clerk.id,
        expectedCash,
        actualCash: expectedCash,
        variance: 0,
      },
    });
    expect(Number(world.till.variance)).toBe(0);
  });

  it("13. posts a balanced journal that carries the day's takings", async () => {
    const result = await generateSalesJournal(DAY, "trading-day-test");
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntry.id },
      include: { lines: { include: { glAccount: true } } },
    });

    const debits = entry.lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0);
    const credits = entry.lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0);
    expect(Math.abs(debits - credits)).toBeLessThan(0.005);

    // SUM, not find: one account can now legitimately carry two lines in a
    // single entry -- Customer Deposits is credited as money arrives and
    // debited when the sale is recognised -- and `find` would silently report
    // whichever the emitter happened to order first.
    const sideTotal = (code: string, side: "debit" | "credit") =>
      entry.lines
        .filter((l) => l.glAccount?.code === code)
        .reduce((sum, l) => sum + Number(l[side] ?? 0), 0);
    const debit = (code: string) => sideTotal(code, "debit");
    const credit = (code: string) => sideTotal(code, "credit");

    // SEAM: the money the register took is the money the journal reports --
    // BOTH tenders, each to its own receipt account.
    expect(debit("1-1006")).toBe(DEPOSIT_CASH + BALANCE_ON_DELIVERY); // cash
    expect(debit("1-1010")).toBe(DEPOSIT_CARD); // card clearing

    // SEAM: the order was invoiced today, so the day recognises revenue rather
    // than parking it in Customer Deposits, and relieves inventory at cost.
    expect(credit("4-4080")).toBe(ORDER_TOTAL);
    expect(debit("5-5280")).toBe(ORDER_TOTAL / 2); // COGS
    expect(credit("1-1380")).toBe(ORDER_TOTAL / 2); // inventory

    // THE REGRESSION GUARD. Over/Short is the balancer's plug. Because the
    // plug makes the entry balance, anything it swallows is invisible: the
    // books tie out, the report looks fine, and the one account whose job is
    // to surface till discrepancies quietly absorbs it. A clean day must not
    // touch it at all.
    expect(debit("5-5900") + credit("5-5900")).toBe(0);

    const posted = await transitionJournalEntry(entry.id, "POSTED", "trading-day-test");
    expect(posted.status).toBe("POSTED");
    world.journalEntryId = entry.id;
  });

  it("13b. refuses to export a journal whose lines have been unbalanced", async () => {
    // The DB constraint compares the HEADER totals. This guard sums the LINES,
    // and it is the only thing standing between a hand-edited entry and an
    // export to the customer's accounting system.
    const line = await prisma.journalEntryLine.findFirstOrThrow({
      where: { journalEntryId: world.journalEntryId, debit: { gt: 0 } },
    });
    const original = Number(line.debit ?? 0);
    await prisma.journalEntryLine.update({
      where: { id: line.id },
      data: { debit: original + 10 },
    });

    await expect(
      transitionJournalEntry(world.journalEntryId, "EXPORTED", "trading-day-test"),
    ).rejects.toThrow(/out of balance/i);

    // Refused, so the entry must be exactly where it was. A guard that throws
    // AFTER writing the status would leave an unbalanced entry marked EXPORTED.
    const after = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: world.journalEntryId },
    });
    expect(after.status).toBe("POSTED");

    await prisma.journalEntryLine.update({
      where: { id: line.id },
      data: { debit: original },
    });
  });

  // The day above invoices on delivery, so its journal recognises revenue and
  // never reaches the deposit branch at all. The NORMAL furniture transaction
  // is the other one: a deposit today against an order that gets delivered and
  // invoiced weeks later. That is where the Over/Short plug used to swallow
  // every non-cash tender, so it needs its own day.
  it("13c. a card deposit on an un-invoiced order credits Deposits, not Over/Short", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Special", lastName: "Order" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-TRADING-DAY-2",
        status: "ORDER",
        orderDate: TRADING_HOUR,
        customerId: customer.id,
        storeLocation: world.store.name,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productName: "Custom Sectional",
              orderedQuantity: 1,
              netPrice: 5000,
              cost: 2500,
              vatRate: 0,
              vatAmount: 0,
            },
          ],
        },
      },
    });

    // A card deposit. No invoice: the sectional is being built.
    await recordPayment(order.id, {
      method: "CARD",
      amount: 1000,
      registerId: world.register.id,
      staffMemberId: world.clerk.id,
      customerId: customer.id,
      cardLast4: "1881",
      cardBrand: "VISA",
    });

    // Regenerate the day now that a second, un-invoiced order exists. The
    // existing entry is POSTED, so start from a clean journal number.
    await prisma.journalEntry.deleteMany({ where: { id: world.journalEntryId } });
    const result = await generateSalesJournal(DAY, "trading-day-test");
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntry.id },
      include: { lines: { include: { glAccount: true } } },
    });
    world.journalEntryId = entry.id;

    const sideTotal = (code: string, side: "debit" | "credit") =>
      entry.lines
        .filter((l) => l.glAccount?.code === code)
        .reduce((sum, l) => sum + Number(l[side] ?? 0), 0);
    const credit = (code: string) => sideTotal(code, "credit");
    const debit = (code: string) => sideTotal(code, "debit");

    // The card deposit is a LIABILITY: the store owes a sectional, not $1,000
    // of income. It belongs in Customer Deposits -- and it is still there at
    // the end of the day, because nothing has been delivered against it.
    //
    // The NET is what matters, because this entry touches the deposit account
    // twice: it credits every deposit taken today (both orders) and debits back
    // the one that was delivered and invoiced today. What is left is exactly
    // the money the business is still holding against an undelivered promise.
    expect(credit("2-2200") - debit("2-2200")).toBe(1000);

    // And it must not have been plugged. Before the fix this line read 1000:
    // the card debit had no offsetting credit, so the balancer put it in the
    // account that exists to report till discrepancies -- silently, because a
    // plugged entry still balances.
    expect(debit("5-5900") + credit("5-5900")).toBe(0);

    // Card clearing carries both orders' card tender.
    expect(debit("1-1010")).toBe(DEPOSIT_CARD + 1000);

    // Post it: the day is not closed until somebody does, and stage 14 reads
    // only POSTED entries.
    await transitionJournalEntry(entry.id, "POSTED", "trading-day-test");
  });

  it("14. reconciles the day: no cash drift, and revenue drift is exactly deferral", async () => {
    const recon = await computeDailyReconciliation({
      date: DAY,
      timeZone: TIME_ZONE,
      client: prisma,
    });

    // SEAM: reconciliation reads the same day the journal posted. A timezone
    // disagreement between these two shows up as phantom drift every day.
    // What the day actually took, read back from the source side.
    // Both orders tendered today: the settled one in full, plus the special
    // order's card deposit.
    expect(recon.source.cash).toBeCloseTo(ORDER_TOTAL + 1000, 2);

    // CASH drift is zero, and that is the fix this file exists for: the
    // journal side now counts every tender's receipt account, not just the one
    // labelled "Cash".
    expect(Math.abs(recon.drift.cash)).toBeLessThan(0.005);
    expect(Math.abs(recon.drift.tax)).toBeLessThan(0.005);

    // REVENUE and COST drift are NOT zero, and this is pinned deliberately.
    //
    // The two sides are on different bases:
    //   source  = bookings   -- every order written today (SALES_REVENUE_STATUSES)
    //   journal = recognised -- only orders carrying an invoice
    //
    // The special order above was written today and will be invoiced on
    // delivery in six weeks, so its 5,000 is deferred revenue and its 2,500 is
    // deferred cost. That is correct accrual accounting on the journal side,
    // and a real figure on the source side -- but the comparison calls the
    // difference "drift", which reads as an error and is not one. For a
    // furniture retailer, where most orders are written before they are
    // delivered, that warning fires every single day.
    //
    // Whether holt should recognise revenue when the ORDER is written or when
    // it is INVOICED is an accounting-policy decision for the deployment, not
    // something to settle inside a test. Until it is settled, this pins the
    // drift to EXACTLY the deferred amount: if it ever differs from the
    // un-invoiced bookings, something other than deferral is wrong.
    const DEFERRED_REVENUE = 5000;
    const DEFERRED_COST = 2500;
    expect(recon.drift.revenue).toBeCloseTo(DEFERRED_REVENUE, 2);
    expect(recon.drift.cost).toBeCloseTo(DEFERRED_COST, 2);

    // The configuration itself is complete -- every warning present is about
    // the deferral above, not about a missing GL mapping.
    expect(recon.warnings.filter((w) => !/drift/i.test(w))).toEqual([]);
  });
});
