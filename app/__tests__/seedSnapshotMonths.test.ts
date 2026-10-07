// /app/__tests__/seedSnapshotMonths.test.ts
//
// The demo seed writes one InventorySnapshot per month for the year before
// "today", and (snapshotDate, productId, storeLocationId) is unique. The dates
// used to be made by moving today's month back and then setting the day to 1.
// On the 29th-31st that lands on a day the target month lacks ("February 30"),
// rolls into the next month, and two months come out as the same date, so the
// seed failed on the unique key. It broke CI's setup/smoke job on 2026-09-30.
// Every day of a common year and of a leap year is checked here.

import { snapshotMonthStarts } from "../prisma/seed/demo/inventoryOps";

function everyDayOf(year: number): Date[] {
  const days: Date[] = [];
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year;) {
    days.push(new Date(d));
    d = new Date(d.getTime() + 86_400_000);
  }
  return days;
}

describe("snapshotMonthStarts", () => {
  it.each([2026, 2028])(
    "gives 12 distinct month starts, one month apart, for every day of %i",
    (year) => {
      for (const today of everyDayOf(year)) {
        const months = snapshotMonthStarts(today, 12);
        const dates = months.map((m) => m.snapshotDate);
        const label = today.toISOString().slice(0, 10);

        expect({ label, distinct: new Set(dates.map((d) => d.getTime())).size }).toEqual({
          label,
          distinct: 12,
        });
        for (const d of dates) {
          expect(d.getUTCDate()).toBe(1);
          expect(d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds()).toBe(0);
        }
        // Consecutive calendar months, ending with the month before today's.
        for (let i = 1; i < dates.length; i++) {
          const prev = dates[i - 1];
          const next = dates[i];
          const monthsApart =
            (next.getUTCFullYear() - prev.getUTCFullYear()) * 12 +
            (next.getUTCMonth() - prev.getUTCMonth());
          expect({ label, i, monthsApart }).toEqual({ label, i, monthsApart: 1 });
        }
        const last = dates[dates.length - 1];
        const expectedLast = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
        expect({ label, last: last.toISOString() }).toEqual({
          label,
          last: expectedLast.toISOString(),
        });
      }
    },
  );

  it("labels each date with how many months ago it is, oldest first", () => {
    const months = snapshotMonthStarts(new Date(Date.UTC(2026, 8, 30)), 12);
    expect(months.map((m) => m.monthsAgo)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(months[0].snapshotDate.toISOString()).toBe("2025-09-01T00:00:00.000Z");
    expect(months[11].snapshotDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});
