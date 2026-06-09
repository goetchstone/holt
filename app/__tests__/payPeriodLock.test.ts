// /app/__tests__/payPeriodLock.test.ts
//
// Pure tests for the pay-period attribution lock logic.

import {
  periodContainsOrderDate,
  isAttributionLocked,
  isOrderLockedByNameOrFk,
  findLockingConfirmation,
  isPeriodConfirmable,
  type ActiveConfirmationLike,
  type ActiveConfirmationWithNames,
} from "../src/lib/payPeriodLock";

const PERIOD_START = new Date("2026-05-18T00:00:00Z");
const PERIOD_END = new Date("2026-05-31T00:00:00Z"); // inclusive last-day midnight

function conf(over: Partial<ActiveConfirmationLike> = {}): ActiveConfirmationLike {
  return {
    staffMemberId: 7,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    reopenedAt: null,
    ...over,
  };
}

describe("periodContainsOrderDate", () => {
  it("includes the first instant of the start day", () => {
    expect(periodContainsOrderDate(PERIOD_START, PERIOD_START, PERIOD_END)).toBe(true);
  });
  it("includes any time on the last day (inclusive)", () => {
    expect(
      periodContainsOrderDate(new Date("2026-05-31T23:59:59Z"), PERIOD_START, PERIOD_END),
    ).toBe(true);
  });
  it("excludes the day before the start", () => {
    expect(
      periodContainsOrderDate(new Date("2026-05-17T23:59:59Z"), PERIOD_START, PERIOD_END),
    ).toBe(false);
  });
  it("excludes the first instant of the day after the end", () => {
    expect(
      periodContainsOrderDate(new Date("2026-06-01T00:00:00Z"), PERIOD_START, PERIOD_END),
    ).toBe(false);
  });
});

describe("isAttributionLocked", () => {
  const orderInPeriod = new Date("2026-05-20T15:00:00Z");
  const orderOutOfPeriod = new Date("2026-06-05T15:00:00Z");

  it("locks when the order's current designer has an active confirmation covering the date", () => {
    expect(isAttributionLocked(orderInPeriod, [7], [conf()])).toBe(true);
  });

  it("locks when the SPLIT partner is the confirmed designer", () => {
    // order belongs to 99 primary + 7 split; designer 7 is locked
    expect(isAttributionLocked(orderInPeriod, [99, 7], [conf()])).toBe(true);
  });

  it("does NOT lock when the confirmation was reopened", () => {
    expect(isAttributionLocked(orderInPeriod, [7], [conf({ reopenedAt: new Date() })])).toBe(false);
  });

  it("does NOT lock an order dated outside the confirmed period", () => {
    expect(isAttributionLocked(orderOutOfPeriod, [7], [conf()])).toBe(false);
  });

  it("does NOT lock when none of the order's designers match the confirmation", () => {
    expect(isAttributionLocked(orderInPeriod, [1, 2, 3], [conf()])).toBe(false);
  });

  it("does NOT lock when orderDate is null", () => {
    expect(isAttributionLocked(null, [7], [conf()])).toBe(false);
  });

  it("does NOT lock when there are no active confirmations", () => {
    expect(isAttributionLocked(orderInPeriod, [7], [])).toBe(false);
  });

  it("locks a reassignment TARGET designer too (moving INTO a locked period)", () => {
    // order currently owned by 1 (unlocked); target is 7 (locked).
    // Caller passes both current + target ids.
    expect(isAttributionLocked(orderInPeriod, [1, 7], [conf()])).toBe(true);
  });
});

describe("findLockingConfirmation", () => {
  it("returns the specific confirmation that locks the order", () => {
    const c = conf();
    const found = findLockingConfirmation(new Date("2026-05-20T00:00:00Z"), [7], [c]);
    expect(found).toBe(c);
  });
  it("returns null when nothing locks", () => {
    expect(findLockingConfirmation(new Date("2026-06-20T00:00:00Z"), [7], [conf()])).toBeNull();
  });
});

describe("isOrderLockedByNameOrFk", () => {
  function confWithNames(
    over: Partial<ActiveConfirmationWithNames> = {},
  ): ActiveConfirmationWithNames {
    return {
      staffMemberId: 7,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      reopenedAt: null,
      names: ["Kim Dransfield"],
      ...over,
    };
  }
  const inPeriod = new Date("2026-05-20T12:00:00Z");

  it("locks an FK-null order whose salesperson STRING matches a confirmed designer", () => {
    const order = {
      orderDate: inPeriod,
      salesPersonId: null,
      splitWithId: null,
      salesperson: "Kim Dransfield",
    };
    expect(isOrderLockedByNameOrFk(order, [confWithNames()])).toBe(true);
  });

  it("matches the salesperson string case-insensitively", () => {
    const order = {
      orderDate: inPeriod,
      salesPersonId: null,
      splitWithId: null,
      salesperson: "kim dransfield",
    };
    expect(isOrderLockedByNameOrFk(order, [confWithNames()])).toBe(true);
  });

  it("still locks by FK even when the string doesn't match", () => {
    const order = {
      orderDate: inPeriod,
      salesPersonId: 7,
      splitWithId: null,
      salesperson: "Stale Name",
    };
    expect(isOrderLockedByNameOrFk(order, [confWithNames()])).toBe(true);
  });

  it("does NOT lock when neither name nor FK matches", () => {
    const order = {
      orderDate: inPeriod,
      salesPersonId: 99,
      splitWithId: null,
      salesperson: "Someone Else",
    };
    expect(isOrderLockedByNameOrFk(order, [confWithNames()])).toBe(false);
  });

  it("does NOT lock an order outside the confirmed period", () => {
    const order = {
      orderDate: new Date("2026-07-01T12:00:00Z"),
      salesPersonId: null,
      splitWithId: null,
      salesperson: "Kim Dransfield",
    };
    expect(isOrderLockedByNameOrFk(order, [confWithNames()])).toBe(false);
  });

  it("does NOT lock when the confirmation is reopened", () => {
    const order = {
      orderDate: inPeriod,
      salesPersonId: null,
      splitWithId: null,
      salesperson: "Kim Dransfield",
    };
    expect(isOrderLockedByNameOrFk(order, [confWithNames({ reopenedAt: new Date() })])).toBe(false);
  });
});

describe("isPeriodConfirmable", () => {
  it("refuses while the period is still in progress", () => {
    const now = new Date("2026-05-25T12:00:00Z"); // mid-period
    const result = isPeriodConfirmable(PERIOD_END, now);
    expect(result.ok).toBe(false);
  });

  it("refuses on the last day of the period (period not fully over)", () => {
    const now = new Date("2026-05-31T23:00:00Z");
    expect(isPeriodConfirmable(PERIOD_END, now).ok).toBe(false);
  });

  it("allows once the period has fully ended (next day)", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(isPeriodConfirmable(PERIOD_END, now).ok).toBe(true);
  });
});
