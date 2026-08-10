// /app/__tests__/dailyReconciliationBusinessDay.test.ts
//
// Pins the WINDOW computeDailyReconciliation queries over, which is the part
// that was wrong and the part no existing test looked at.
//
// The bug: the caller resolved "yesterday" in the deployment's business
// timezone, and then computeDailyReconciliation threw that away --
// `startOfDay`/`endOfDay` did setUTCHours(0..) / setUTCHours(23:59:59.999) on
// the incoming date and reconciled the UTC calendar day. For America/New_York
// that shifted the window 4-5 hours off the trading day, so a store's evening
// landed in the next day's reconciliation. For any timezone EAST of UTC the
// caller's businessDayStart anchor fell on the previous UTC date, so the whole
// run reconciled the wrong day.
//
// Two conventions have to stay straight, and mixing them is what made this
// subtle:
//
//   SOURCES  (SalesOrder.orderDate, Payment.paymentDate) are INSTANTS. They get
//            the half-open business-day window [dayStart, dayEndExclusive).
//   JOURNAL  (JournalEntry.journalDate) is a DATE MARKER -- UTC midnight of the
//            calendar day. It gets an exact marker match. Filtering the marker
//            by the instant window would find nothing for any timezone west of
//            UTC, because the marker sits BEFORE the window opens.
//
// No module mocking here, deliberately: `timeZone` is a parameter precisely so
// this module never reaches lib/prisma. dailyReconciliationDisplay.ts imports
// it and is reached from JournalEntriesView, a "use client" component -- see
// the parameter's doc comment for what that cost.

import { businessDayRange } from "@/lib/reports/businessDay";
import { computeDailyReconciliation } from "@/lib/dailyReconciliation";

interface Captured {
  orderDate?: { gte: Date; lt: Date };
  paymentDate?: { gte: Date; lt: Date };
  journalDate?: unknown;
}

function fakeClient(captured: Captured) {
  return {
    accountGroup: { findMany: async () => [] },
    taxDistrict: { findMany: async () => [] },
    systemGLMapping: { findMany: async () => [] },
    orderLineItem: {
      findMany: async (args: { where: { salesOrder: { orderDate: { gte: Date; lt: Date } } } }) => {
        captured.orderDate = args.where.salesOrder.orderDate;
        return [];
      },
    },
    payment: {
      findMany: async (args: { where: { paymentDate: { gte: Date; lt: Date } } }) => {
        captured.paymentDate = args.where.paymentDate;
        return [];
      },
    },
    journalEntry: {
      findFirst: async (args: { where: { journalDate: unknown } }) => {
        captured.journalDate = args.where.journalDate;
        return null;
      },
    },
  } as unknown as Parameters<typeof computeDailyReconciliation>[0]["client"];
}

/** The date MARKER a caller passes: UTC midnight of the calendar day. */
const marker = (key: string) => new Date(`${key}T00:00:00.000Z`);

async function windowFor(key: string, timeZone: string): Promise<Captured> {
  const captured: Captured = {};
  await computeDailyReconciliation({ date: marker(key), timeZone, client: fakeClient(captured) });
  return captured;
}

describe("computeDailyReconciliation reconciles the BUSINESS day", () => {
  it.each([
    "America/New_York",
    "America/Los_Angeles",
    "UTC",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Pacific/Auckland",
  ])("%s: sources are queried over the business day, not the UTC day", async (tz) => {
    const captured = await windowFor("2026-06-09", tz);
    const expected = businessDayRange("2026-06-09", tz);
    expect(captured.orderDate).toEqual({ gte: expected.gte, lt: expected.lt });
    expect(captured.paymentDate).toEqual({ gte: expected.gte, lt: expected.lt });
  });

  it("America/New_York queries a window offset from UTC midnight", async () => {
    const { orderDate } = await windowFor("2026-06-09", "America/New_York");
    // The exact instants the old setUTCHours() code could never produce.
    expect(orderDate!.gte.toISOString()).toBe("2026-06-09T04:00:00.000Z");
    expect(orderDate!.lt.toISOString()).toBe("2026-06-10T04:00:00.000Z");
  });

  it("Asia/Tokyo reconciles the requested date, not the day before", async () => {
    const { orderDate } = await windowFor("2026-06-09", "Asia/Tokyo");
    // Tokyo's June 9 opens at 15:00Z on June 8. The window must still COVER
    // June 9 local; the old code queried [Jun 8 00:00Z .. Jun 8 23:59Z].
    expect(orderDate!.gte.toISOString()).toBe("2026-06-08T15:00:00.000Z");
    expect(orderDate!.lt.toISOString()).toBe("2026-06-09T15:00:00.000Z");
  });

  it("spans 25 hours on a fall-back DST day and 23 on spring-forward", async () => {
    const hours = async (key: string) => {
      const { orderDate } = await windowFor(key, "America/New_York");
      return (orderDate!.lt.getTime() - orderDate!.gte.getTime()) / 3_600_000;
    };
    expect(await hours("2026-11-01")).toBe(25); // fall back
    expect(await hours("2026-03-08")).toBe(23); // spring forward
  });

  it("matches the journal on its DATE MARKER, never on the instant window", async () => {
    const { journalDate } = await windowFor("2026-06-09", "America/New_York");
    // An exact Date, not a {gte,lt} range. The June 9 marker (00:00Z) is four
    // hours BEFORE the window opens, so a range match would find no journal and
    // report a reconciled day as missing its entry.
    expect(journalDate).toBeInstanceOf(Date);
    expect((journalDate as Date).toISOString()).toBe("2026-06-09T00:00:00.000Z");
  });
});
