// /app/__tests__/integration/reportsBusinessDay.integration.test.ts
//
// A sale belongs to the business's day, month and year, not UTC's.
//
// Monthly Performance, Salesperson Detail and Sales Performance cut their
// periods at UTC midnight, so an Eastern store's 9pm sale on the last day of a
// month (02:00 UTC the next day) was reported in the NEXT month, a New Year's
// Eve evening sale in the next year, and a one-day Sales Performance range
// missed its own evening. They now bucket in AppSettings.timezone
// (lib/reports/businessDay.ts); with no settings row that is America/New_York.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { getMonthlyPerformance } from "@/lib/reports/monthlyPerformance";
import { getSalespersonDetail } from "@/lib/reports/salespersonDetail";
import { getSalesPerformance } from "@/lib/reports/salesPerformance";

async function sale(orderno: string, instant: string, netPrice: number, salesPersonId: number) {
  await prisma.salesOrder.create({
    data: {
      orderno,
      orderDate: new Date(instant),
      status: "ORDER",
      salesperson: "Pat Designer",
      salesPersonId,
      storeLocation: "Test Store",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Sofa",
            orderedQuantity: 1,
            netPrice,
            cost: netPrice / 2,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateAppSettingsCache();
  const pat = await prisma.staffMember.create({
    data: { displayName: "Pat Designer", role: "DESIGNER", isDesigner: true },
  });
  // 9pm on 31 January in New York.
  await sale("SO-JAN31-EVE", "2026-02-01T02:00:00.000Z", 100, pat.id);
  // 9pm on New Year's Eve 2025 in New York.
  await sale("SO-NYE-EVE", "2026-01-01T02:00:00.000Z", 50, pat.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("reports bucket sales by business day", () => {
  it("Monthly Performance keeps the 31 Jan evening sale in January, and NYE in 2025", async () => {
    const report = await getMonthlyPerformance(prisma, { salesperson: "Pat Designer", year: 2026 });
    expect(report.months[0].sales).toBe(100); // January: only the 31 Jan sale
    expect(report.months[1].sales).toBe(0); // February: nothing
  });

  it("Salesperson Detail files the order under January, dated the 31st", async () => {
    const report = await getSalespersonDetail(prisma, { salesperson: "Pat Designer", year: 2026 });
    expect(report.months.map((m) => [m.month, m.totalSales])).toEqual([["2026-01", 100]]);
    expect(report.months[0].customers[0].orders[0].orderDate).toBe("2026-01-31");
    expect(report.ytdTotal).toBe(100);
  });

  it("Sales Performance's one-day range includes that day's evening", async () => {
    const report = await getSalesPerformance(prisma, {
      startDate: "2026-01-31",
      endDate: "2026-01-31",
    });
    expect(report.kpis.totalSales).toBe(100);
    expect(report.dailyTrend).toEqual([{ date: "2026-01-31", totalSales: 100, orderCount: 1 }]);
  });
});
