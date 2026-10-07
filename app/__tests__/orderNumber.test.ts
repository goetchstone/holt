// /app/__tests__/orderNumber.test.ts
//
// USE-12: an order number is `<prefix>-YYMMDD-NNN`, where the prefix is the
// business's and YYMMDD is the business day in the business's timezone -- not
// the server's clock, which numbered a 9 pm Eastern sale for tomorrow on a UTC
// server.

import { nextOrderNumber, orderNumberStem } from "@/lib/orderNumber";

/** A salesOrder.findFirst that answers from a fixed list, as Prisma would. */
function fakeTx(existing: string[]) {
  const findFirstImpl = async ({ where }: { where: { orderno: { startsWith: string } } }) => {
    const matching = existing.filter((o) => o.startsWith(where.orderno.startsWith)).sort();
    return matching.length ? { orderno: matching[matching.length - 1] } : null;
  };
  const findFirst = jest.fn(findFirstImpl);
  const calls: string[] = [];
  findFirst.mockImplementationOnce(async (args) => {
    calls.push("read");
    return findFirstImpl(args);
  });
  // A tagged template: the stem arrives as the first interpolated value.
  const $executeRaw = jest.fn(async (_sql: TemplateStringsArray, stem: string) => {
    calls.push(`lock ${stem}`);
    return 0;
  });
  return { tx: { salesOrder: { findFirst }, $executeRaw } as never, findFirst, calls };
}

// 02:00 UTC on 24 Sep is still 22:00 on 23 Sep in New York.
const LATE_EVENING_EASTERN = new Date("2026-09-24T02:00:00Z");

describe("orderNumberStem", () => {
  it("dates the stem by the business's day, not UTC's", () => {
    expect(orderNumberStem("HR", "America/New_York", LATE_EVENING_EASTERN)).toBe("HR-260923-");
    expect(orderNumberStem("HR", "UTC", LATE_EVENING_EASTERN)).toBe("HR-260924-");
  });
});

describe("nextOrderNumber", () => {
  it("starts the day at 001", async () => {
    const { tx } = fakeTx([]);
    await expect(nextOrderNumber(tx, "HR", "UTC", LATE_EVENING_EASTERN)).resolves.toBe(
      "HR-260924-001",
    );
  });

  it("continues after the day's highest number, ignoring other days and prefixes", async () => {
    const { tx, findFirst } = fakeTx([
      "HR-260923-001",
      "HR-260923-002",
      "HR-260922-009",
      "XY-260923-050",
    ]);
    await expect(nextOrderNumber(tx, "HR", "America/New_York", LATE_EVENING_EASTERN)).resolves.toBe(
      "HR-260923-003",
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderno: { startsWith: "HR-260923-" } } }),
    );
  });

  // QUA-15: the day's numbering is locked before it is read, so two sales at
  // once cannot take the same number (orderNumberConcurrency.integration).
  it("locks the day's stem before reading the day's highest number", async () => {
    const { tx, calls } = fakeTx(["HR-260923-001"]);
    await nextOrderNumber(tx, "HR", "America/New_York", LATE_EVENING_EASTERN);
    expect(calls).toEqual(["lock HR-260923-", "read"]);
  });
});
