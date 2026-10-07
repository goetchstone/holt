// /app/__tests__/integration/orderNumberConcurrency.integration.test.ts
//
// QUA-15: two sales finalised at the same moment each get their own order
// number. nextOrderNumber reads the day's highest number and adds one; without
// a lock, two transactions both read the same highest number, both pick the
// next, and the second insert fails on the unique `orderno` -- a sale refused
// at the register with "Failed to create order". The route does real work
// between taking the number and inserting the order (products, tax,
// allocation); the pause below stands in for it, which makes the race certain
// instead of lucky.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { nextOrderNumber, orderNumberStem } from "@/lib/orderNumber";

const NOW = new Date("2026-09-23T15:00:00Z");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("order numbers under concurrent sales (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("gives ten simultaneous orders ten consecutive numbers, and refuses none", async () => {
    const place = () =>
      prisma.$transaction(
        async (tx) => {
          const orderno = await nextOrderNumber(tx, "TST", "UTC", NOW);
          await pause(50); // the route's work between numbering and inserting
          await tx.salesOrder.create({ data: { orderno } });
          return orderno;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );

    const results = await Promise.allSettled(Array.from({ length: 10 }, place));
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(0);

    const stem = orderNumberStem("TST", "UTC", NOW);
    const numbers = results.map((r) => (r as PromiseFulfilledResult<string>).value).sort();
    expect(numbers).toEqual(
      Array.from({ length: 10 }, (_, i) => `${stem}${String(i + 1).padStart(3, "0")}`),
    );
  });
});
