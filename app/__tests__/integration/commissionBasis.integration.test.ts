// /app/__tests__/integration/commissionBasis.integration.test.ts
//
// `CommissionPlan.countsWhen` has always existed with WRITTEN | DELIVERED, and
// has always been a lie. It was resolved in commissionRules.ts:258 and then
// DROPPED -- nothing downstream read it, so every plan behaved as WRITTEN
// whatever the admin screen said. It could not have worked either way before
// SalesOrder.deliveredAt existed: there was no delivery date to window on.
//
// The distinction is real and stores genuinely differ on it. A sofa written in
// March and delivered in June belongs to March's commission on one basis and
// June's on the other, and the difference is somebody's pay.
//
// This proves the setting changes the answer -- which is the only way to know
// a configuration is wired rather than decorative.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { sumDesignerSales, loadDesignerSaleRows } from "@/lib/commissionSales";

const WRITTEN_ON = new Date("2026-03-10T15:00:00Z");
const DELIVERED_ON = new Date("2026-06-18T15:00:00Z");

const MARCH = { start: new Date("2026-03-01T00:00:00Z"), end: new Date("2026-04-01T00:00:00Z") };
const JUNE = { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-07-01T00:00:00Z") };

let designerId: number;
let matchNames: string[];

beforeAll(async () => {
  await resetTestDb();

  const designer = await prisma.staffMember.create({
    data: { displayName: "Dana Reyes", isDesigner: true, isActive: true },
  });
  designerId = designer.id;
  matchNames = [designer.displayName];

  const customer = await prisma.customer.create({
    data: { firstName: "Slow", lastName: "Sofa" },
  });

  // The furniture case: written in March, delivered in June.
  await prisma.salesOrder.create({
    data: {
      orderno: "SO-BASIS-1",
      status: "FULFILLED",
      orderDate: WRITTEN_ON,
      deliveredAt: DELIVERED_ON,
      customerId: customer.id,
      salesPersonId: designer.id,
      salesperson: designer.displayName,
      storeLocation: "Main Street",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Sectional",
            orderedQuantity: 1,
            netPrice: 4000,
            cost: 2000,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });

  // And one still undelivered -- a promise. It counts on the WRITTEN basis and
  // must count nowhere at all on the DELIVERED one.
  await prisma.salesOrder.create({
    data: {
      orderno: "SO-BASIS-2",
      status: "ORDER",
      orderDate: WRITTEN_ON,
      customerId: customer.id,
      salesPersonId: designer.id,
      salesperson: designer.displayName,
      storeLocation: "Main Street",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Armchair",
            orderedQuantity: 1,
            netPrice: 1000,
            cost: 500,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
});

describe("countsWhen decides which period a sale belongs to (real DB)", () => {
  it("WRITTEN counts both orders in March, and nothing in June", async () => {
    expect(await sumDesignerSales(designerId, matchNames, MARCH.start, MARCH.end, "WRITTEN")).toBe(
      5000,
    );
    expect(await sumDesignerSales(designerId, matchNames, JUNE.start, JUNE.end, "WRITTEN")).toBe(0);
  });

  it("DELIVERED counts the delivered sofa in June, and nothing in March", async () => {
    expect(
      await sumDesignerSales(designerId, matchNames, MARCH.start, MARCH.end, "DELIVERED"),
    ).toBe(0);
    expect(await sumDesignerSales(designerId, matchNames, JUNE.start, JUNE.end, "DELIVERED")).toBe(
      4000,
    );
  });

  it("an undelivered order is commissionable on WRITTEN and on no DELIVERED period", async () => {
    // The £1,000 armchair. Under DELIVERED it is a promise, and a promise is
    // not commissionable in ANY period until it goes -- not deferred to one,
    // absent from all of them.
    const wholeYear = {
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2027-01-01T00:00:00Z"),
    };
    expect(
      await sumDesignerSales(designerId, matchNames, wholeYear.start, wholeYear.end, "WRITTEN"),
    ).toBe(5000);
    expect(
      await sumDesignerSales(designerId, matchNames, wholeYear.start, wholeYear.end, "DELIVERED"),
    ).toBe(4000);
  });

  it("attributes each row to the same date it was windowed on", async () => {
    // The rule engine buckets rows by `occurredAt`. Windowing on delivery and
    // then attributing on the order date would put a sale in one period and its
    // commission in another -- the kind of split nobody notices until a
    // designer's statement disagrees with their payslip.
    const written = await loadDesignerSaleRows(
      designerId,
      matchNames,
      MARCH.start,
      MARCH.end,
      "WRITTEN",
    );
    expect(written.every((r) => r.occurredAt.getTime() === WRITTEN_ON.getTime())).toBe(true);

    const delivered = await loadDesignerSaleRows(
      designerId,
      matchNames,
      JUNE.start,
      JUNE.end,
      "DELIVERED",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].occurredAt.getTime()).toBe(DELIVERED_ON.getTime());
  });
});
