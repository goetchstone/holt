// /app/__tests__/integration/demoSeedSound.integration.test.ts
//
// The demo seed's staff step and the checks the seed runs on its own output
// (prisma/seed/demo/verify.ts), against the real database.
//
// `npm run seed:all` resets the database, which empties the Role table, and
// only afterwards ran the role seeder. Every staff member it seeded had a role
// name and no role: Admin > Roles showed nobody on any role, in every demo.
// `npm run seed:coverage` could not see it, because it asks whether a table
// has rows, not whether they are right.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { stockAt } from "../helpers/stock";
import { seedCustomerLedgers } from "../../prisma/seed/demo/customerLedgers";
import { seedStaff } from "../../prisma/seed/demo/staff";
import { assertSeedIsSound, seedProblems } from "../../prisma/seed/demo/verify";

async function seededStaff() {
  const stores = await Promise.all(
    [
      { name: "Harbor Showroom", code: "HS1" },
      { name: "Falls Showroom", code: "FS1" },
    ].map((store) =>
      prisma.storeLocation.create({
        data: { ...store, type: "STORE" },
        select: { id: true, code: true },
      }),
    ),
  );
  return seedStaff(prisma, stores, stores[0].id, 4);
}

// Once, after every describe in the file: a disconnect inside the first one is
// undone by the next describe's first query.
afterAll(async () => {
  await prisma.$disconnect();
});

describe("the demo seed's staff", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("are each on the role their role name says, starting from a database with no roles", async () => {
    // resetTestDb leaves no Role rows, as `seed:demo -- --reset` does.
    expect(await prisma.role.count()).toBe(0);

    const staff = await seededStaff();

    const rows = await prisma.staffMember.findMany({
      select: { role: true, roleRef: { select: { key: true } } },
    });
    expect(rows).toHaveLength(staff.all.length);
    expect(rows.filter((row) => row.roleRef?.key !== row.role)).toEqual([]);
    // What Admin > Roles counts: the people linked to each role.
    const designers = await prisma.role.findUniqueOrThrow({
      where: { key: "DESIGNER" },
      select: { _count: { select: { staff: true } } },
    });
    expect(designers._count.staff).toBe(rows.filter((r) => r.role === "DESIGNER").length);
    expect(await seedProblems(prisma)).toEqual([]);
  });

  it("fail the seed's own check when one is linked to no role, or to the wrong one", async () => {
    await seededStaff();
    const [unlinked, wrong] = await prisma.staffMember.findMany({
      where: { role: "REGISTER" },
      orderBy: { id: "asc" },
      take: 2,
    });
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.staffMember.update({ where: { id: unlinked.id }, data: { roleId: null } });
    await prisma.staffMember.update({ where: { id: wrong.id }, data: { roleId: manager.id } });

    expect(await seedProblems(prisma)).toEqual([
      `Staff member "${unlinked.displayName}" has role REGISTER but is linked to no Role.`,
      `Staff member "${wrong.displayName}" has role REGISTER but is linked to Role "MANAGER".`,
    ]);
    await expect(assertSeedIsSound(prisma)).rejects.toThrow(/2 problem\(s\)/);
  });

  it("fail the seed's own check when an order's seller is not named both ways", async () => {
    const staff = await seededStaff();
    const [first, second] = staff.all;
    const order = { status: "QUOTE" as const, orderDate: new Date("2026-11-01") };
    await prisma.salesOrder.createMany({
      data: [
        { ...order, orderno: "Q-1", salesperson: first.displayName, salesPersonId: first.id },
        // The seed's own name, the staff member's name with no link, the link
        // with no name, and a link to somebody else.
        { ...order, orderno: "Q-2", salesperson: "seed:demo" },
        { ...order, orderno: "Q-3", salesperson: first.displayName },
        { ...order, orderno: "Q-4", salesPersonId: first.id },
        { ...order, orderno: "Q-5", salesperson: first.displayName, salesPersonId: second.id },
        // A walk-in sale with nobody named is not a problem.
        { ...order, orderno: "Q-6", salesperson: null },
      ],
    });

    expect(await seedProblems(prisma)).toEqual([
      'Order Q-2 names the salesperson "seed:demo" and is linked to no staff member.',
      `Order Q-3 names the salesperson "${first.displayName}" and is linked to no staff member.`,
      `Order Q-4 names the salesperson null and is linked to "${first.displayName}".`,
      `Order Q-5 names the salesperson "${first.displayName}" and is linked to "${second.displayName}".`,
    ]);
  });
});

describe("the seed's own check of orders and the stock held for them", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  /** A store with one place for stock, and one product. */
  async function shop() {
    const store = await prisma.storeLocation.create({
      data: { name: "Harbor Showroom", code: "HS1", type: "STORE" },
    });
    const place = await prisma.stockLocation.create({
      data: { name: "Back stock", code: "BACK", storeLocationId: store.id },
    });
    const vendor = await prisma.vendor.create({ data: { name: "Harbor Works" } });
    const department = await prisma.department.create({ data: { name: "Living" } });
    const category = await prisma.category.create({
      data: { name: "Sofas", departmentId: department.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "SOFA-1",
        name: "Sofa",
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
    return { store, place, product };
  }

  /** An order of two sofas, with `handedOver` of them gone to the customer. */
  async function orderOfTwo(
    productId: number,
    orderno: string,
    data: { status: "QUOTE" | "ORDER" | "FULFILLED" | "RETURNED"; deliveredAt?: Date },
    handedOver = 0,
  ) {
    return prisma.salesOrder.create({
      data: {
        orderno,
        orderDate: new Date("2026-11-01"),
        ...data,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId,
              orderedQuantity: 2,
              netPrice: 2000,
              cost: 800,
              fulfilledQty: handedOver,
            },
            // A cancelled line is not goods to hand over.
            {
              lineNumber: 2,
              productId,
              orderedQuantity: 1,
              netPrice: 1000,
              cost: 400,
              lineItemStatus: "CANCELLED",
            },
          ],
        },
      },
    });
  }

  it("passes a delivered order handed over in full, and an open one with part of it gone", async () => {
    const { product } = await shop();
    const day = new Date("2026-11-03");
    await orderOfTwo(product.id, "SO-1", { status: "FULFILLED", deliveredAt: day }, 2);
    await orderOfTwo(product.id, "SO-2", { status: "ORDER" }, 1);
    await orderOfTwo(product.id, "SO-3", { status: "ORDER" });

    expect(await seedProblems(prisma)).toEqual([]);
  });

  it("fails on a delivered order with nothing handed over, and on an open one with all of it gone", async () => {
    const { product } = await shop();
    const day = new Date("2026-11-03");
    // What every delivered order in the demo looked like.
    await orderOfTwo(product.id, "SO-1", { status: "FULFILLED", deliveredAt: day });
    await orderOfTwo(product.id, "SO-2", { status: "ORDER" }, 2);
    await orderOfTwo(product.id, "SO-3", { status: "FULFILLED" }, 2);
    await orderOfTwo(product.id, "SO-4", { status: "ORDER", deliveredAt: day });
    await orderOfTwo(product.id, "SO-5", { status: "ORDER" }, 3);

    expect(await seedProblems(prisma)).toEqual([
      "Order SO-1 is FULFILLED with 0 of 2 handed over.",
      "Order SO-2 is ORDER with 2 of 2 handed over.",
      "Order SO-3 is FULFILLED without a delivered date.",
      "Order SO-4 is ORDER with a delivered date.",
      "Order SO-5 is ORDER with 3 of 2 handed over.",
    ]);
  });

  it("fails on stock held for an order that has gone, and on more than an order is waiting for", async () => {
    const { store, place, product } = await shop();
    const day = new Date("2026-11-03");
    const hold = (salesOrderId: number, quantity: number) =>
      stockAt({
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: place.id,
        salesOrderId,
        quantity,
      });
    const waiting = await orderOfTwo(product.id, "SO-1", { status: "ORDER" });
    const partGone = await orderOfTwo(product.id, "SO-2", { status: "ORDER" }, 1);
    const gone = await orderOfTwo(product.id, "SO-3", { status: "FULFILLED", deliveredAt: day }, 2);
    const tooMuch = await orderOfTwo(product.id, "SO-4", { status: "ORDER" });
    await hold(waiting.id, 2);
    await hold(partGone.id, 1);
    // What a transfer "raised for a customer order" left behind.
    await hold(gone.id, 2);
    await hold(tooMuch.id, 3);
    // Free stock is nobody's.
    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: place.id,
      quantity: 4,
    });

    expect(await seedProblems(prisma)).toEqual([
      `2 of product ${product.id} is held for order SO-3, which is FULFILLED.`,
      `3 of product ${product.id} is held for order SO-4, which is waiting for 2.`,
    ]);
  });

  it("fails on a delivery or a pickup with no customer, and not on a floor sale", async () => {
    const order = { status: "ORDER" as const, orderDate: new Date("2026-11-01") };
    const customer = await prisma.customer.create({
      data: { firstName: "Ana", lastName: "Reyes" },
    });
    await prisma.salesOrder.createMany({
      data: [
        { ...order, orderno: "SO-1", deliveryMethod: "DELIVERY" },
        { ...order, orderno: "SO-2", deliveryMethod: "PICKUP" },
        { ...order, orderno: "SO-3", deliveryMethod: "TAKEN" },
        { ...order, orderno: "SO-4", deliveryMethod: "DELIVERY", customerId: customer.id },
      ],
    });

    expect(await seedProblems(prisma)).toEqual([
      "Order SO-1 is for DELIVERY and names no customer.",
      "Order SO-2 is for PICKUP and names no customer.",
    ]);
  });

  it("spells out the first five of one kind of problem and counts the rest", async () => {
    const order = { status: "QUOTE" as const, orderDate: new Date("2026-11-01") };
    await prisma.salesOrder.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        ...order,
        orderno: `Q-${i + 1}`,
        salesperson: "seed:demo",
      })),
    });

    const problems = await seedProblems(prisma);

    expect(problems).toHaveLength(6);
    expect(problems[5]).toBe("... and 3 more of the same kind.");
    await expect(assertSeedIsSound(prisma)).rejects.toThrow(/6 problem\(s\)/);
  });
});

describe("the seed's customer ledgers, and its check of them", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  /** A customer with one order of $1,000 and $60 tax, and the payments given. */
  async function customerWithOrder(
    status: "QUOTE" | "ORDER" | "FULFILLED",
    payments: { paymentAmount: number; status: "COMPLETED" | "PENDING" }[],
  ) {
    const customer = await prisma.customer.create({
      data: { firstName: "Ana", lastName: "Reyes" },
    });
    const day = new Date("2026-11-01T15:00:00Z");
    // A delivered order is delivered in the other checks' eyes too.
    const delivered = status === "FULFILLED";
    await prisma.salesOrder.create({
      data: {
        orderno: `SO-${customer.id}`,
        status,
        orderDate: day,
        created: day,
        deliveredAt: delivered ? day : null,
        customerId: customer.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 1000,
              vatAmount: 60,
              cost: 400,
              orderedQuantity: 1,
              fulfilledQty: delivered ? 1 : 0,
            },
          ],
        },
        payments: {
          create: payments.map((p) => ({
            ...p,
            paymentDate: day,
            created: day,
            paymentType: "Card",
          })),
        },
      },
    });
    return customer;
  }

  const owed = async (customerId: number) =>
    Number((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).openArBalance);

  it("builds each customer's ledger from their orders and payments, and says who owes what", async () => {
    // A deposit order, a sale paid in full, and a quote with a payment link nobody paid.
    const deposit = await customerWithOrder("ORDER", [{ paymentAmount: 530, status: "COMPLETED" }]);
    const paid = await customerWithOrder("FULFILLED", [
      { paymentAmount: 1060, status: "COMPLETED" },
    ]);
    const quoted = await customerWithOrder("QUOTE", [{ paymentAmount: 1060, status: "PENDING" }]);

    const result = await seedCustomerLedgers(prisma);

    expect(result).toEqual({
      customersWithALedger: 2,
      entriesCreated: 4,
      customersOwing: 1,
      totalOwed: 530,
    });
    expect([await owed(deposit.id), await owed(paid.id), await owed(quoted.id)]).toEqual([
      530, 0, 0,
    ]);
    expect(await seedProblems(prisma)).toEqual([]);
  });

  it("fails the seed's own check when a customer's ledger was never built", async () => {
    const customer = await customerWithOrder("ORDER", [
      { paymentAmount: 530, status: "COMPLETED" },
    ]);

    // What every customer in the demo looked like: orders, payments, no ledger.
    expect(await seedProblems(prisma)).toEqual([
      `Customer ${customer.id} is stored as owing 0.00; their ledger adds up to 0.00 and their ` +
        `orders and payments to 530.00.`,
    ]);
  });

  it("fails the seed's own check when what is stored and the ledger part ways", async () => {
    const customer = await customerWithOrder("ORDER", [
      { paymentAmount: 530, status: "COMPLETED" },
    ]);
    await seedCustomerLedgers(prisma);
    await prisma.customer.update({ where: { id: customer.id }, data: { openArBalance: 99 } });

    expect(await seedProblems(prisma)).toEqual([
      `Customer ${customer.id} is stored as owing 99.00; their ledger adds up to 530.00 and their ` +
        `orders and payments to 530.00.`,
    ]);
  });

  it("stops the seed when a ledger entry was written before the ledgers were built", async () => {
    const customer = await customerWithOrder("ORDER", [
      { paymentAmount: 530, status: "COMPLETED" },
    ]);
    // What a seed module calling the application's own payment code would leave.
    await prisma.customerLedgerEntry.create({
      data: {
        customerId: customer.id,
        type: "PAYMENT",
        amount: -530,
        balanceBefore: 0,
        balanceAfter: -530,
        createdBy: "seed:demo",
      },
    });

    await expect(seedCustomerLedgers(prisma)).rejects.toThrow(
      /1 customer ledger\(s\) do not agree [\s\S]* 1 with entries from before this ran/,
    );
  });
});
