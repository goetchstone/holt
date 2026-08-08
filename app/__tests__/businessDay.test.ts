// /app/__tests__/businessDay.test.ts
//
// The bug these exist to prevent, in one line: a sofa sold at 8pm Friday was
// being reported on Saturday, because the code read the calendar date off a UTC
// instant instead of asking where the store is.
//
// Pure functions only — the timezone is a parameter, so none of this needs a
// database. getBusinessTimeZone (the one async part) is covered in CI.

import { businessDayKey, businessDayRange, businessDayStart } from "@/lib/reports/businessDay";

const ET = "America/New_York";
const PT = "America/Los_Angeles";

describe("businessDayKey — the date is the date", () => {
  it("keeps an evening sale on the day it was sold", () => {
    // 8pm Eastern on the 8th is already 00:00Z on the 9th. This is the exact
    // case salesDaily got wrong: toISOString().slice(0,10) returns "2026-08-09".
    const sold = new Date("2026-08-08T20:00:00-04:00");
    expect(sold.toISOString().slice(0, 10)).toBe("2026-08-09"); // the old behaviour
    expect(businessDayKey(sold, ET)).toBe("2026-08-08"); // the right answer
  });

  it("agrees with the old behaviour when the day does not cross", () => {
    // 2pm Eastern never crossed midnight UTC, which is why nobody noticed.
    const sold = new Date("2026-08-08T14:00:00-04:00");
    expect(sold.toISOString().slice(0, 10)).toBe("2026-08-08");
    expect(businessDayKey(sold, ET)).toBe("2026-08-08");
  });

  it("is worse the further west you are — a Pacific afternoon", () => {
    // 4pm Pacific is 23:00Z; 5pm is already tomorrow in UTC. A California store
    // would lose most of its afternoon to the next day.
    expect(businessDayKey(new Date("2026-08-08T16:00:00-07:00"), PT)).toBe("2026-08-08");
    expect(businessDayKey(new Date("2026-08-08T17:00:00-07:00"), PT)).toBe("2026-08-08");
    expect(new Date("2026-08-08T17:00:00-07:00").toISOString().slice(0, 10)).toBe("2026-08-09");
  });

  it("puts a sale one minute before close on the right day", () => {
    expect(businessDayKey(new Date("2026-08-08T23:59:00-04:00"), ET)).toBe("2026-08-08");
  });

  it("puts a sale one minute after midnight on the next day", () => {
    expect(businessDayKey(new Date("2026-08-09T00:01:00-04:00"), ET)).toBe("2026-08-09");
  });
});

describe("businessDayStart / businessDayRange", () => {
  it("starts the day at local midnight, not UTC midnight", () => {
    // Midnight Eastern on 2026-08-08 is 04:00Z, not 00:00Z.
    expect(businessDayStart("2026-08-08", ET).toISOString()).toBe("2026-08-08T04:00:00.000Z");
  });

  it("returns a half-open range so no sale falls between two days", () => {
    const { gte, lt } = businessDayRange("2026-08-08", ET);
    const lastMoment = new Date("2026-08-08T23:59:59.999-04:00");
    expect(lastMoment >= gte).toBe(true);
    expect(lastMoment < lt).toBe(true);
  });

  it("handles the spring-forward day, which is 23 hours long", () => {
    // US DST begins 2026-03-08. Adding a fixed 24h to the start would overshoot
    // into the 9th by an hour; deriving from the next day's start does not.
    const { gte, lt } = businessDayRange("2026-03-08", ET);
    expect(lt.getTime() - gte.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(businessDayKey(new Date(lt.getTime() - 1), ET)).toBe("2026-03-08");
  });

  it("handles the fall-back day, which is 25 hours long", () => {
    // US DST ends 2026-11-01.
    const { gte, lt } = businessDayRange("2026-11-01", ET);
    expect(lt.getTime() - gte.getTime()).toBe(25 * 60 * 60 * 1000);
    expect(businessDayKey(new Date(lt.getTime() - 1), ET)).toBe("2026-11-01");
  });

  it("a range's own boundaries round-trip to the day they came from", () => {
    for (const day of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
      const { gte, lt } = businessDayRange(day, ET);
      expect(businessDayKey(gte, ET)).toBe(day);
      expect(businessDayKey(new Date(lt.getTime() - 1), ET)).toBe(day);
    }
  });
});
